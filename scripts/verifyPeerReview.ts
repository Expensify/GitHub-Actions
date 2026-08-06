#!/usr/bin/env -S node --import tsx

import CLI from 'expensify-common/CLI';

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

// GitHub's List commits on a pull request endpoint never returns more than 250 commits, no matter how it's paginated,
// so commit authorship can't be reliably determined above this count.
const MAX_VERIFIABLE_COMMITS = 250;

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

async function getIndependentEmployeeApprovers(gitHubUtils: GitHubUtils, approvers: string[], authors: string[]): Promise<string[]> {
    const authorsSet = new Set(authors);
    const independentApprovers = approvers.filter((approver) => !authorsSet.has(approver));
    return CollectionUtils.filterAsync(independentApprovers, (approver) => gitHubUtils.isExpensifyEmployee(approver));
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
    const independentEmployeeApprovers = await getIndependentEmployeeApprovers(gitHubUtils, approvers, authors);
    if (independentEmployeeApprovers.length >= effectiveRequiredApprovingReviewCount) {
        return {
            status: 'pass',
            reason: `${prSlug} has ${independentEmployeeApprovers.length}/${effectiveRequiredApprovingReviewCount} independent Expensify employee approval(s).`,
        };
    }

    console.error('Insufficient independent peer review', {
        commitAuthors: authors,
        allAuthorsAreBots: areAllAuthorsBots,
        approvers,
        independentApprovers: independentEmployeeApprovers,
        required: effectiveRequiredApprovingReviewCount,
    });
    const botOnlyNote =
        effectiveRequiredApprovingReviewCount > requiredApprovingReviewCount
            ? ` Pull requests authored solely by bots require a minimum of ${effectiveRequiredApprovingReviewCount} independent Expensify employee approvals.`
            : '';
    return {
        status: 'fail',
        error: new WorkflowError({title: 'Missing independent peer review', message: `${prSlug} does not have enough independent Expensify employee approvals.${botOnlyNote}`}),
    };
}

async function main(gitHubUtilsOverride?: GitHubUtils): Promise<void> {
    /* eslint-disable @typescript-eslint/naming-convention -- CLI uses kebab-case argument names */
    const cli = new CLI({
        namedArgs: {
            owner: {
                description: 'Repository owner organization or user login',
            },
            repo: {
                description: 'Repository name',
            },
            'pull-request-number': {
                description: 'Pull request number',
                parse: (value: string) => {
                    const number = Number(value);
                    if (!Number.isInteger(number) || number <= 0) {
                        throw new Error('Must be a positive integer');
                    }
                    return number;
                },
            },
            'target-branch': {
                description: 'Ref for the branch into which the pull request is being merged e.g. "refs/heads/main"',
            },
            'actor-type': {
                description: 'GitHub actor type of the user who triggered the event (Bot or User)',
                parse: (value: string): ActorType => {
                    if (value !== 'Bot' && value !== 'User') {
                        throw new Error('Must be "Bot" or "User"');
                    }
                    return value;
                },
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const owner = cli.namedArgs.owner;
    const repo = cli.namedArgs.repo;
    const pullRequestNumber = cli.namedArgs['pull-request-number'];
    const targetBranch = cli.namedArgs['target-branch'];
    const actorType = cli.namedArgs['actor-type'];

    const gitHubUtils = gitHubUtilsOverride ?? createGitHubUtils(GitHubAPIClient.fromEnv());
    const result = await evaluatePeerReview(gitHubUtils, {
        owner,
        repo,
        prNumber: pullRequestNumber,
        targetBranch,
        actorType,
    });

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
    getIndependentEmployeeApprovers,
    getCommitAuthors,
};

if (import.meta.main) {
    main().catch((error) => {
        GitHubWorkflowUtils.emitFailure(error, 'Peer review verification failed');
    });
}
