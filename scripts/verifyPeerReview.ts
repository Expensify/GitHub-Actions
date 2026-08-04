#!/usr/bin/env -S node --import tsx

import CLI from 'expensify-common/CLI';

import CollectionUtils from './libs/CollectionUtils';
import GitCommitUtils from './libs/GitCommitUtils';
import GitHubUtils from './libs/GitHubUtils';
import type {ActorType} from './libs/GitHubUtils';
import GitHubWorkflowUtils from './libs/GitHubWorkflowUtils';

type PeerReviewInput = {
    owner: string;
    repo: string;
    prNumber: number;
    targetBranch: string;
    actorType: ActorType;
};

type PeerReviewResult = {status: 'pass'; reason: string} | {status: 'skip'; reason: string} | {status: 'fail'; error: Error};

async function getCommitAuthors({owner, repo, prNumber, actorType}: {owner: string; repo: string; prNumber: number; actorType: ActorType}): Promise<string[]> {
    const commits = await GitHubUtils.listPullRequestCommits({owner, repo, number: prNumber});
    const authors = new Set<string>();

    console.log('Checking commit authors', {
        commitCount: commits.length,
    });

    for (const commit of commits) {
        const canonicalAuthor = GitCommitUtils.getCanonicalAuthorLogin(commit);
        authors.add(canonicalAuthor);

        // Co-authorship between two humans from making and accepting a suggestion does not violate peer review.
        // Only parse co-authors when the canonical commit author is a bot.
        if (!GitHubUtils.isBotUser(canonicalAuthor, actorType)) {
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
                throw new Error(`Unable to resolve co-author email to GitHub user: ${coAuthorEmail}`);
            }
        }
    }

    return CollectionUtils.uniqueSorted([...authors]);
}

async function getIndependentEmployeeApprovers(approvers: string[], authors: string[]): Promise<string[]> {
    const authorsSet = new Set(authors);
    const independentApprovers = approvers.filter((approver) => !authorsSet.has(approver));
    return CollectionUtils.filterAsync(independentApprovers, (approver) => GitHubUtils.isExpensifyEmployee(approver));
}

async function evaluatePeerReview(input: PeerReviewInput): Promise<PeerReviewResult> {
    const {owner, repo, prNumber, targetBranch, actorType} = input;
    const prSlug = `${owner}/${repo}#${prNumber}`;

    console.log('Evaluating PR', {
        repo,
        prNumber,
        targetBranch,
        htmlURL: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    });

    const requiredApprovingReviewCount = await GitHubUtils.getRequiredApprovingReviewCount({owner, repo, baseRef: targetBranch});
    if (requiredApprovingReviewCount === 0) {
        return {
            status: 'skip',
            reason: `${prSlug} targets ${targetBranch}, which does not require approving reviews.`,
        };
    }

    const authors = await getCommitAuthors({owner, repo, prNumber, actorType});

    // Unlike the PHP chore, which logs a bugbot and skips when no commit authors can be determined,
    // we fail the check here so an unresolvable PR can't merge without independent review.
    if (authors.length === 0) {
        return {
            status: 'fail',
            error: new Error(`Unable to determine any commit authors for ${prSlug}.`),
        };
    }

    // A bot-only author list can't be trusted the way a human author list can: a human could have
    // asked the bot to omit them as a co-author to dodge peer review. We don't block these PRs
    // outright, since some (e.g. Snyk upgrades) are never co-authored by a human, but we require
    // two independent reviewers instead of one so a single reviewer can't rubber-stamp the bypass.
    const areAllAuthorsBots = authors.every((author) => GitHubUtils.isBotUser(author, actorType));
    const effectiveRequiredApprovingReviewCount = areAllAuthorsBots ? Math.max(requiredApprovingReviewCount, 2) : requiredApprovingReviewCount;

    const approvers = await GitHubUtils.getLatestApprovers({owner, repo, number: prNumber});
    const independentEmployeeApprovers = await getIndependentEmployeeApprovers(approvers, authors);
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
        error: new Error(`${prSlug} does not have enough independent Expensify employee approvals.${botOnlyNote}`),
    };
}

function getFailureTitle(message: string): string {
    if (message.includes('does not have enough independent Expensify employee approvals')) {
        return 'Missing independent peer review';
    }
    if (message.includes('Unable to resolve co-author emails')) {
        return 'Unresolved co-author';
    }
    if (message.includes('Unable to resolve canonical commit author')) {
        return 'Missing commit author';
    }
    if (message.includes('Unable to determine any commit authors')) {
        return 'No commit authors found';
    }
    if (message.includes('Unable to read branch protection rules')) {
        return 'Branch protection lookup failed';
    }
    return 'Peer review verification failed';
}

async function main(): Promise<void> {
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
                description: 'Target branch ref for the pull request',
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

    const result = await evaluatePeerReview({
        owner,
        repo,
        prNumber: pullRequestNumber,
        targetBranch,
        actorType,
    });

    if (result.status === 'skip' || result.status === 'pass') {
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
    getFailureTitle,
};

if (import.meta.main) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        GitHubWorkflowUtils.emitFailure(error, getFailureTitle(message));
    });
}
