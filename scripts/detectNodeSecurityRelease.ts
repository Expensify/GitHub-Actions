#!/usr/bin/env -S node --import tsx

import {RequestError} from '@octokit/request-error';

import GitHubAPIClient from './libs/GitHubAPIClient';
import GitHubWorkflowUtils from './libs/GitHubWorkflowUtils';
import type {NodeBumpConfig} from './libs/NodeBumpConfigUtils';
import NodeBumpConfigUtils from './libs/NodeBumpConfigUtils';
import type {NvmrcPin} from './libs/NodeBumpUtils';
import NodeBumpUtils from './libs/NodeBumpUtils';
import type {NodeRelease} from './libs/NodeReleaseUtils';
import NodeReleaseUtils from './libs/NodeReleaseUtils';

/**
 * Only security releases this recent get a tracking issue, so a new or long-broken workflow doesn't open issues for old releases.
 */
const MAX_RELEASE_AGE_DAYS = 14;

const WORKFLOW_URL = 'https://github.com/Expensify/GitHub-Actions/actions/workflows/bumpNode.yml';

type RepoPin = {
    name: string;
    pin: NvmrcPin;
    holdForBuildBoxes: boolean;
};

function getPinMajor(pin: NvmrcPin): number {
    return pin.type === 'exact' ? NodeReleaseUtils.getMajor(pin.version) : pin.major;
}

async function getRepoPins(client: GitHubAPIClient, config: NodeBumpConfig): Promise<RepoPin[]> {
    const repoPins = await Promise.all(
        config.repos.map(async (repo): Promise<RepoPin | null> => {
            try {
                const response = await client.octokit.repos.getContent({owner: config.owner, repo: repo.name, path: '.nvmrc', mediaType: {format: 'raw'}});
                const content: unknown = response.data;
                const pin = typeof content === 'string' ? NodeBumpUtils.parseNvmrc(content) : null;
                if (!pin) {
                    console.warn(`${repo.name}/.nvmrc does not hold a Node.js version, skipping it`);
                    return null;
                }
                return {name: repo.name, pin, holdForBuildBoxes: repo.holdForBuildBoxes ?? false};
            } catch (error) {
                if (error instanceof RequestError && error.status === 404) {
                    console.warn(`${repo.name} has no .nvmrc, skipping it`);
                    return null;
                }
                throw error;
            }
        }),
    );
    return repoPins.filter((repoPin) => repoPin !== null);
}

function mentionsRelease(title: string, version: string): boolean {
    return title.includes('Node.js') && new RegExp(`(?<![\\d.])${version.replaceAll('.', '\\.')}(?![\\d.])`).test(title);
}

async function isTracked(client: GitHubAPIClient, config: NodeBumpConfig, release: NodeRelease): Promise<boolean> {
    const response = await client.octokit.search.issuesAndPullRequests({
        q: `repo:${config.owner}/${config.trackingIssueRepo} is:issue in:title "${release.version}" Node.js`,
    });
    return response.data.items.some((issue) => mentionsRelease(issue.title, release.version));
}

function getTrackingIssueTitle(releases: NodeRelease[]): string {
    const versions = releases.map((release) => release.version);
    return `Roll out the Node.js ${versions.join(' and ')} security release${versions.length > 1 ? 's' : ''}`;
}

function getTrackingIssueBody(releases: NodeRelease[], repoPins: RepoPin[]): string {
    const releasedMajors = new Set(releases.map((release) => NodeReleaseUtils.getMajor(release.version)));
    const rows = releases.map((release) => {
        const reposOnLine = repoPins.filter((repoPin) => getPinMajor(repoPin.pin) === NodeReleaseUtils.getMajor(release.version));
        const exactRepos = reposOnLine.filter((repoPin) => repoPin.pin.type === 'exact').map((repoPin) => repoPin.name);
        const floatingRepos = reposOnLine.filter((repoPin) => repoPin.pin.type === 'major').map((repoPin) => repoPin.name);
        return `| [${release.version}](${NodeReleaseUtils.getReleaseNotesURL(release.version)}) | ${release.npm} | ${exactRepos.join(', ') || 'None'} | ${floatingRepos.join(', ') || 'None'} |`;
    });

    const buildBoxRepos = repoPins.filter((repoPin) => repoPin.holdForBuildBoxes && releasedMajors.has(getPinMajor(repoPin.pin))).map((repoPin) => repoPin.name);
    const steps = [
        `- [ ] Run the [Bump Node workflow](${WORKFLOW_URL}) with this issue's URL, first as a dry run. It opens a pull request in every repo that pins an exact version.`,
        '- [ ] Decide whether developer machines and builds must move to this release too. If so, run the workflow again with `RAISE_MINIMUMS` checked, so the repos that float on the line require it.',
    ];
    if (buildBoxRepos.length > 0) {
        steps.push(
            `- [ ] Publish the Node.js apt mirror and upgrade Node.js on the build boxes, which build ${buildBoxRepos.join(', ')}. Pull requests for those repos stay on \`[HOLD]\` until then.`,
        );
    }
    steps.push('- [ ] Merge the pull requests.');

    return [
        'Node.js published a security release on a line our repos use.',
        '',
        '| Release | npm | Repos that pin an exact version | Repos that float on the line |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
        'Repos that float on the line install the new release in CI on their next run. Repos that pin an exact version need a pull request.',
        '',
        '## Rollout',
        '',
        ...steps,
    ].join('\n');
}

async function main(): Promise<void> {
    const config = NodeBumpConfigUtils.loadNodeBumpConfig();
    const client = GitHubAPIClient.fromEnv();
    const [releases, repoPins] = await Promise.all([NodeReleaseUtils.fetchNodeReleases(), getRepoPins(client, config)]);

    const recentReleases = NodeReleaseUtils.findRecentSecurityReleases(
        releases,
        repoPins.map((repoPin) => getPinMajor(repoPin.pin)),
        new Date(),
        MAX_RELEASE_AGE_DAYS,
    );
    const trackedFlags = await Promise.all(recentReleases.map((release) => isTracked(client, config, release)));
    const untrackedReleases = recentReleases.filter((_release, index) => !trackedFlags.at(index));
    if (untrackedReleases.length === 0) {
        console.log('No new Node.js security release to track');
        return;
    }

    const {data: issue} = await client.octokit.issues.create({
        owner: config.owner,
        repo: config.trackingIssueRepo,
        title: getTrackingIssueTitle(untrackedReleases),
        body: getTrackingIssueBody(untrackedReleases, repoPins),
        labels: config.trackingIssueLabels,
    });
    console.log(`Opened ${issue.html_url}`);
    await GitHubWorkflowUtils.writeStepSummary('Opened a tracking issue', issue.html_url);
}

export type {RepoPin};

export default {
    getTrackingIssueBody,
    getTrackingIssueTitle,
    mentionsRelease,
};

if (import.meta.main) {
    main().catch((error: unknown) => {
        GitHubWorkflowUtils.emitFailure(error, 'Node.js security release detection failed');
    });
}
