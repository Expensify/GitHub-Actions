#!/usr/bin/env bun

import CollectionUtils from './libs/CollectionUtils';
import GitCommitUtils from './libs/GitCommitUtils';
import GitHubAPIClient from './libs/GitHubAPIClient';
import createGitHubUtils from './libs/GitHubUtils';
import type {ActorType, GitHubUtils} from './libs/GitHubUtils';
import GitHubWorkflowUtils, {WorkflowError} from './libs/GitHubWorkflowUtils';

type PeerReviewInput = {
    owner: string;
    repo: string;
    prNumber: number;
    targetBranch: string;
    actorType: ActorType;
};

type PeerReviewResult = {status: 'pass'; reason: string} | {status: 'fail'; error: Error};

type PeerReviewCLIArgName = 'owner' | 'repo' | 'pull-request-number' | 'target-branch' | 'actor-type';

function isPeerReviewCLIArgName(value: string): value is PeerReviewCLIArgName {
    return value === 'owner' || value === 'repo' || value === 'pull-request-number' || value === 'target-branch' || value === 'actor-type';
}

// GitHub's List commits on a pull request endpoint never returns more than 250 commits, no matter how it's paginated,
// so commit authorship can't be reliably determined above this count.
const MAX_VERIFIABLE_COMMITS = 250;
const EXPENSIFY_EMPLOYEE_TEAM_SLUG = 'expensify-expensify';
const REPOSITORY_REVIEWER_TEAMS = new Map([
    ['Expensify/react-native-wallet', ['react-native-wallet-writers']],
    ['Expensify/react-native-live-markdown', ['react-native-live-markdown-writers', 'react-native-live-markdown-maintainers']],
]);

async function getCommitAuthors(gitHubUtils: GitHubUtils, {owner, repo, prNumber, actorType}: {owner: string; repo: string; prNumber: number; actorType: ActorType}): Promise<string[]> {
    const commits = await gitHubUtils.listPullRequestCommits({owner, repo, number: prNumber});
    const authors = new Set<string>();

    console.log('Checking commit authors', {
        commitCount: commits.length,
    });

    for (const commit of commits) {
        const canonicalAuthor = GitCommitUtils.getCanonicalAuthorLogin(commit);
        authors.add(canonicalAuthor);

        // Co-authorship between two humans from making and accepting a suggestion does not violate peer review.
        // Only parse co-authors when the canonical commit author is a bot.
        if (!gitHubUtils.isBotUser(canonicalAuthor, actorType)) {
            console.log('Not considering co-author an author since canonical author is human', {
                commitSHA: commit.sha,
                canonicalAuthor,
            });
            continue;
        }

        for (const coAuthorEmail of GitCommitUtils.parseCoAuthorEmails(commit.commit.message)) {
            const login = GitCommitUtils.resolveNoreplyEmailToLogin(coAuthorEmail);
            if (login) {
                authors.add(login);
            } else {
                throw new WorkflowError({title: 'Unresolved co-author', message: `Unable to resolve co-author email to GitHub user: ${coAuthorEmail}`});
            }
        }
    }

    return CollectionUtils.uniqueSorted([...authors]);
}

async function getIndependentApprovers(gitHubUtils: GitHubUtils, approvers: string[], authors: string[], owner: string, repo: string): Promise<string[]> {
    const authorsSet = new Set(authors);
    const independentApprovers = approvers.filter((approver) => !authorsSet.has(approver));
    const reviewerTeams = [EXPENSIFY_EMPLOYEE_TEAM_SLUG, ...(REPOSITORY_REVIEWER_TEAMS.get(`${owner}/${repo}`) ?? [])];
    const teamMembers = await Promise.all(reviewerTeams.map((teamSlug) => gitHubUtils.getTeamMemberLogins(teamSlug)));
    const eligibleReviewers = new Set(teamMembers.flatMap((members) => [...members]));

    return independentApprovers.filter((approver) => eligibleReviewers.has(approver));
}

async function evaluatePeerReview(gitHubUtils: GitHubUtils, input: PeerReviewInput): Promise<PeerReviewResult> {
    const {owner, repo, prNumber, targetBranch, actorType} = input;
    const prSlug = `${owner}/${repo}#${prNumber}`;

    console.log('Evaluating PR', {
        repo,
        prNumber,
        targetBranch,
        htmlURL: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    });

    const requiredApprovingReviewCount = await gitHubUtils.getRequiredApprovingReviewCount({owner, repo, baseRef: targetBranch});
    if (requiredApprovingReviewCount === 0) {
        return {
            status: 'pass',
            reason: `${prSlug} targets ${targetBranch}, which does not require approving reviews.`,
        };
    }

    const commitCount = await gitHubUtils.getPullRequestCommitCount({owner, repo, number: prNumber});
    if (commitCount > MAX_VERIFIABLE_COMMITS) {
        return {
            status: 'fail',
            error: new WorkflowError({
                title: 'Too many commits to verify',
                message: `${prSlug} has ${commitCount} commits, which exceeds the ${MAX_VERIFIABLE_COMMITS}-commit limit of GitHub's commit-listing API. Commit authorship can't be reliably verified above this limit, so please split this PR into smaller pieces.`,
            }),
        };
    }

    const authors = await getCommitAuthors(gitHubUtils, {owner, repo, prNumber, actorType});

    // Unlike the PHP chore, which logs a bugbot and skips when no commit authors can be determined,
    // we fail the check here so an unresolvable PR can't be merged without independent review.
    if (authors.length === 0) {
        return {
            status: 'fail',
            error: new WorkflowError({title: 'No commit authors found', message: `Unable to determine any commit authors for ${prSlug}.`}),
        };
    }

    // A bot-only author list can't be trusted the way a human author list can: a human could have
    // asked the bot to omit them as a co-author to dodge peer review. We don't block these PRs
    // outright, since some (e.g. Snyk upgrades, HelpDot changes) are never co-authored by a human.
    // In those cases, we require at least two independent reviewers in case the first reviewer was actually a secret co-author.
    const areAllAuthorsBots = authors.every((author) => gitHubUtils.isBotUser(author, actorType));
    const effectiveRequiredApprovingReviewCount = areAllAuthorsBots ? Math.max(requiredApprovingReviewCount, 2) : requiredApprovingReviewCount;

    const approvers = await gitHubUtils.getLatestApprovers({owner, repo, number: prNumber});
    const independentApprovers = await getIndependentApprovers(gitHubUtils, approvers, authors, owner, repo);
    if (independentApprovers.length >= effectiveRequiredApprovingReviewCount) {
        return {
            status: 'pass',
            reason: `${prSlug} has ${independentApprovers.length}/${effectiveRequiredApprovingReviewCount} independent eligible reviewer approval(s).`,
        };
    }

    console.error('Insufficient independent peer review', {
        commitAuthors: authors,
        allAuthorsAreBots: areAllAuthorsBots,
        approvers,
        independentApprovers,
        required: effectiveRequiredApprovingReviewCount,
    });
    const botOnlyNote =
        effectiveRequiredApprovingReviewCount > requiredApprovingReviewCount
            ? ` Pull requests authored solely by bots require a minimum of ${effectiveRequiredApprovingReviewCount} independent eligible reviewer approvals.`
            : '';
    return {
        status: 'fail',
        error: new WorkflowError({title: 'Missing independent peer review', message: `${prSlug} does not have enough independent eligible reviewer approvals.${botOnlyNote}`}),
    };
}

function parseCLIArgs(args: string[]): PeerReviewInput {
    const namedArgs = new Map<PeerReviewCLIArgName, string>();

    for (let index = 0; index < args.length; index += 2) {
        const rawName = args.at(index)?.replace(/^--/, '');
        const value = args.at(index + 1);
        if (!rawName || !isPeerReviewCLIArgName(rawName) || !value) {
            throw new Error(`Invalid CLI argument: ${args.at(index) ?? ''}`);
        }
        namedArgs.set(rawName, value);
    }

    const getRequiredArg = (name: PeerReviewCLIArgName): string => {
        const value = namedArgs.get(name);
        if (!value) {
            throw new Error(`Missing required CLI argument: --${name}`);
        }
        return value;
    };

    const pullRequestNumber = Number(getRequiredArg('pull-request-number'));
    if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
        throw new Error('--pull-request-number must be a positive integer');
    }

    const actorType = getRequiredArg('actor-type');
    if (actorType !== 'Bot' && actorType !== 'User') {
        throw new Error('--actor-type must be "Bot" or "User"');
    }

    return {
        owner: getRequiredArg('owner'),
        repo: getRequiredArg('repo'),
        prNumber: pullRequestNumber,
        targetBranch: getRequiredArg('target-branch'),
        actorType,
    };
}

async function main(gitHubUtilsOverride?: GitHubUtils, args = Bun.argv.slice(2)): Promise<void> {
    const input = parseCLIArgs(args);

    const gitHubUtils = gitHubUtilsOverride ?? createGitHubUtils(GitHubAPIClient.fromEnv());
    const result = await evaluatePeerReview(gitHubUtils, input);

    if (result.status === 'pass') {
        console.log(result.reason);
        return;
    }

    throw result.error;
}

export type {PeerReviewInput, PeerReviewResult};

export default {
    main,
    evaluatePeerReview,
    getIndependentApprovers,
    getCommitAuthors,
};

if (import.meta.main) {
    main().catch((error) => {
        GitHubWorkflowUtils.emitFailure(error, 'Peer review verification failed');
    });
}
