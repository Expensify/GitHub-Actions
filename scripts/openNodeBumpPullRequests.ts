#!/usr/bin/env -S node --import tsx

import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as core from '@actions/core';
import CLI from 'expensify-common/CLI';

import GitHubAPIClient from './libs/GitHubAPIClient';
import GitHubWorkflowUtils, {WorkflowError} from './libs/GitHubWorkflowUtils';
import type {NodeBumpRepo} from './libs/NodeBumpConfigUtils';
import NodeBumpConfigUtils from './libs/NodeBumpConfigUtils';
import NodeBumpUtils, {SPARSE_CHECKOUT_PATTERNS} from './libs/NodeBumpUtils';
import type {NodeRelease} from './libs/NodeReleaseUtils';
import NodeReleaseUtils from './libs/NodeReleaseUtils';

const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/;

type PullRequestContent = {
    repo: NodeBumpRepo;
    from: NodeRelease;
    to: NodeRelease;

    /** Whether the repo floats on the line, so the bump raises its minimum instead of an exact pin */
    floats: boolean;

    includesSecurityFix: boolean;
    issueURL: string;
    runURL?: string;
};

type RepoResult = {
    repo: string;
    outcome: string;
    failed?: boolean;
};

type Options = {
    owner: string;
    token: string;
    releases: NodeRelease[];
    requestedReleases: NodeRelease[];
    dryRun: boolean;
    issueURL: string;
    coAuthorTrailer: string;
    runURL?: string;
    workDir: string;
};

function getCommitHeadline({to, floats}: Pick<PullRequestContent, 'to' | 'floats'>): string {
    return floats ? `Require Node.js ${to.version} or newer` : `Bump Node.js to ${to.version}`;
}

function getPullRequestTitle(content: PullRequestContent): string {
    const prefixes = [content.repo.holdForBuildBoxes ? '[HOLD]' : '', content.includesSecurityFix ? (content.repo.securityReleaseTitlePrefix ?? '') : '', '[No QA]'].filter(Boolean);
    return `${prefixes.join(' ')} ${getCommitHeadline(content)}`;
}

function getPullRequestBody({repo, from, to, floats, includesSecurityFix, issueURL, runURL}: PullRequestContent): string {
    const major = NodeReleaseUtils.getMajor(to.version);
    const release = `[${to.version}](${NodeReleaseUtils.getReleaseNotesURL(to.version)})`;
    const securityNote = includesSecurityFix ? ', which includes security fixes' : '';
    const npmNote = to.npm === from.npm ? '' : ` npm moves from ${from.npm} to ${to.npm}, the version bundled with Node.js ${to.version}.`;

    const explanation = floats
        ? `Raises the minimum Node.js version from ${from.version} to ${release}${securityNote}, so every developer machine and build has to move to it. CI already installs the newest ${major}.x release on its own.`
        : `Moves Node.js from ${from.version} to ${release}${securityNote}, the newest release on the ${major}.x line.${npmNote}`;
    const holdNote = repo.holdForBuildBoxes
        ? [
              '',
              `Merge this only after the build boxes run Node.js ${to.version}${floats ? ' or newer' : ''}. Jenkins builds this repo there and checks the Node.js version first, so the build fails until then.`,
          ]
        : [];
    const versionCheck = floats ? `\`node -v\` prints \`v${to.version}\` or a newer v${major}.x release` : `\`node -v\` prints \`v${to.version}\` and \`npm -v\` prints \`${to.npm}\``;

    return [
        '### Explanation of Change',
        explanation,
        ...holdNote,
        '',
        '### Fixed Issues',
        `For ${issueURL}`,
        '',
        '### Tests',
        `1. Run \`nvm install\` and confirm ${versionCheck}.`,
        '2. Run `npm ci` and confirm it succeeds.',
        '',
        '### QA',
        'None. This only changes the Node.js version used to develop, test and build.',
        ...(runURL ? ['', `Opened by the [Bump Node workflow](${runURL}).`] : []),
    ].join('\n');
}

function getCoAuthorTrailer(login: string, id: string): string {
    if (!login) {
        return '';
    }
    if (!/^\d+$/.test(id)) {
        throw new Error('--co-author-id must be the numeric GitHub user ID of --co-author-login');
    }
    return `Co-authored-by: ${login} <${id}+${login}@users.noreply.github.com>`;
}

function runGit(args: string[], token: string, cwd?: string): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The token goes in an environment-provided header so it never shows up in arguments, logs or .git/config.
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_LFS_SKIP_SMUDGE: '1',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        },
    });
}

/**
 * Clones only the files that pin Node.js versions, so large repos like App take seconds.
 */
function cloneVersionFiles(owner: string, repo: string, token: string, workDir: string): string {
    const repoDir = path.join(workDir, repo);
    mkdirSync(repoDir);
    runGit(['clone', '--quiet', '--depth=1', '--filter=blob:none', '--no-checkout', `https://github.com/${owner}/${repo}.git`, repoDir], token);
    runGit(['sparse-checkout', 'set', '--no-cone', ...SPARSE_CHECKOUT_PATTERNS], token, repoDir);
    runGit(['checkout', '--quiet'], token, repoDir);
    return repoDir;
}

/**
 * Commits the changed files to a new branch through the GraphQL API, which signs the commit, then opens the pull request.
 * Deletes the branch again if anything fails, so the next run can retry.
 */
async function openPullRequest(
    client: GitHubAPIClient,
    {
        owner,
        repo,
        repoDir,
        branch,
        files,
        headline,
        body,
        title,
        pullRequestBody,
    }: {
        owner: string;
        repo: string;
        repoDir: string;
        branch: string;
        files: string[];
        headline: string;
        body: string;
        title: string;
        pullRequestBody: string;
    },
    token: string,
): Promise<string> {
    const baseBranch = runGit(['symbolic-ref', '--short', 'HEAD'], token, repoDir).trim();
    const baseSHA = runGit(['rev-parse', 'HEAD'], token, repoDir).trim();

    await client.octokit.git.createRef({owner, repo, ref: `refs/heads/${branch}`, sha: baseSHA});
    try {
        await client.graphql(
            `
            mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
                createCommitOnBranch(input: $input) {
                    commit {
                        oid
                    }
                }
            }
        `,
            {
                input: {
                    branch: {repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch},
                    message: {headline, body},
                    fileChanges: {additions: files.map((file) => ({path: file, contents: readFileSync(path.join(repoDir, file)).toString('base64')}))},
                    expectedHeadOid: baseSHA,
                },
            },
        );
        const {data: pullRequest} = await client.octokit.pulls.create({owner, repo, title, body: pullRequestBody, head: branch, base: baseBranch});
        return pullRequest.html_url;
    } catch (error) {
        await client.octokit.git.deleteRef({owner, repo, ref: `heads/${branch}`}).catch((deleteError: unknown) => {
            console.warn(`Could not delete ${owner}/${repo}@${branch}`, deleteError);
        });
        throw error;
    }
}

async function bumpRepo(client: GitHubAPIClient, repo: NodeBumpRepo, options: Options): Promise<RepoResult> {
    const repoDir = cloneVersionFiles(options.owner, repo.name, options.token, options.workDir);
    const plan = NodeBumpUtils.planRepoBump(repoDir, options.releases, options.requestedReleases);
    if (plan.status === 'skipped') {
        return {repo: repo.name, outcome: plan.reason};
    }

    const files = NodeBumpUtils.bumpNodeVersionFiles(repoDir, plan.from, plan.to);
    const change = `${plan.from.version} → ${plan.to.version}`;
    if (options.dryRun) {
        console.log(runGit(['--no-pager', 'diff'], options.token, repoDir));
        return {repo: repo.name, outcome: `${change}: would change ${files.join(', ')}`};
    }

    const branch = `bump-node-${plan.to.version}`;
    const {data: openPullRequests} = await client.octokit.pulls.list({owner: options.owner, repo: repo.name, head: `${options.owner}:${branch}`, state: 'open'});
    const existingPullRequest = openPullRequests.at(0);
    if (existingPullRequest) {
        return {repo: repo.name, outcome: `${change}: already open at ${existingPullRequest.html_url}`};
    }

    const content: PullRequestContent = {
        repo,
        from: plan.from,
        to: plan.to,
        floats: plan.floats,
        includesSecurityFix: NodeReleaseUtils.includesSecurityFix(options.releases, plan.from, plan.to),
        issueURL: options.issueURL,
        runURL: options.runURL,
    };
    const url = await openPullRequest(
        client,
        {
            owner: options.owner,
            repo: repo.name,
            repoDir,
            branch,
            files,
            headline: getCommitHeadline(content),
            body: [`For ${options.issueURL}`, options.coAuthorTrailer].filter(Boolean).join('\n\n'),
            title: getPullRequestTitle(content),
            pullRequestBody: getPullRequestBody(content),
        },
        options.token,
    );
    return {repo: repo.name, outcome: `${change}: ${url}`};
}

function getResultsTable(results: RepoResult[]): string {
    return ['| Repo | Result |', '| --- | --- |', ...results.map((result) => `| ${result.repo} | ${result.outcome.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`)].join('\n');
}

function getRunURL(): string | undefined {
    const {GITHUB_SERVER_URL: serverURL, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runID} = process.env;
    return serverURL && repository && runID ? `${serverURL}/${repository}/actions/runs/${runID}` : undefined;
}

async function main(): Promise<void> {
    /* eslint-disable @typescript-eslint/naming-convention -- CLI uses kebab-case argument names */
    const cli = new CLI({
        flags: {
            'dry-run': {
                description: 'Print the changes instead of opening pull requests',
            },
        },
        namedArgs: {
            'issue-url': {
                description: 'Tracking issue the pull requests are for',
                parse: (value: string) => {
                    if (!ISSUE_URL_PATTERN.test(value)) {
                        throw new Error('Must be a GitHub issue URL');
                    }
                    return value;
                },
            },
            version: {
                description:
                    'Comma-separated Node.js versions, at most one per major line, such as "26.13.1,24.22.3". Repos that pin an exact release move to the one on their line, and repos that float raise their minimum to it',
            },
            repos: {
                description: 'Comma-separated repos to bump. Defaults to every repo in config/nodeBump.json',
                default: '',
            },
            'co-author-login': {
                description: 'GitHub login of the person running the workflow, added as a co-author so peer review needs someone else',
                default: '',
            },
            'co-author-id': {
                description: 'Numeric GitHub user ID of --co-author-login',
                default: '',
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
    }

    const config = NodeBumpConfigUtils.loadNodeBumpConfig();
    const requestedRepoNames = cli.namedArgs.repos
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    const unknownRepoNames = requestedRepoNames.filter((name) => !config.repos.some((repo) => repo.name === name));
    if (unknownRepoNames.length > 0) {
        throw new Error(`Not in config/nodeBump.json: ${unknownRepoNames.join(', ')}`);
    }
    const repos = requestedRepoNames.length > 0 ? config.repos.filter((repo) => requestedRepoNames.includes(repo.name)) : config.repos;

    const issueURL = cli.namedArgs['issue-url'];
    const releases = await NodeReleaseUtils.fetchNodeReleases();
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'node-bump-'));
    const options: Options = {
        owner: config.owner,
        token,
        releases,
        requestedReleases: NodeReleaseUtils.findRequestedReleases(releases, cli.namedArgs.version),
        dryRun: cli.flags['dry-run'],
        issueURL,
        coAuthorTrailer: getCoAuthorTrailer(cli.namedArgs['co-author-login'], cli.namedArgs['co-author-id']),
        runURL: getRunURL(),
        workDir,
    };

    const client = GitHubAPIClient.fromEnv();
    const results: RepoResult[] = [];
    try {
        for (const repo of repos) {
            console.log(`::group::${repo.name}`);
            try {
                // One repo at a time keeps the clones, API calls and logs easy to follow.
                // eslint-disable-next-line no-await-in-loop
                results.push(await bumpRepo(client, repo, options));
            } catch (error) {
                results.push({repo: repo.name, outcome: `Failed: ${error instanceof Error ? error.message : String(error)}`, failed: true});
            }
            console.log(results.at(-1)?.outcome);
            console.log('::endgroup::');
        }
    } finally {
        rmSync(workDir, {recursive: true, force: true});
    }

    const table = getResultsTable(results);
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) {
        await core.summary
            .addHeading(options.dryRun ? 'Node bump dry run' : 'Node bump', 2)
            .addRaw(table, true)
            .write();
    }

    if (!options.dryRun) {
        const [, issueOwner, issueRepo, issueNumber] = ISSUE_URL_PATTERN.exec(issueURL) ?? [];
        await client.octokit.issues.createComment({
            owner: issueOwner,
            repo: issueRepo,
            // eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub API parameter
            issue_number: Number(issueNumber),
            body: [`The [Bump Node workflow](${options.runURL ?? 'https://github.com/Expensify/GitHub-Actions/actions/workflows/bumpNode.yml'}) ran:`, '', table].join('\n'),
        });
    }

    const failedRepos = results.filter((result) => result.failed).map((result) => result.repo);
    if (failedRepos.length > 0) {
        throw new WorkflowError({title: 'Some Node bumps failed', message: `These repos failed: ${failedRepos.join(', ')}. See the log of each one above.`});
    }
}

export type {PullRequestContent};

export default {
    getCoAuthorTrailer,
    getPullRequestBody,
    getPullRequestTitle,
    getResultsTable,
};

if (import.meta.main) {
    main().catch((error: unknown) => {
        GitHubWorkflowUtils.emitFailure(error, 'Opening the Node bump pull requests failed');
    });
}
