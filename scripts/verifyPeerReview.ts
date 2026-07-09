#!/usr/bin/env -S node --import tsx

import CLI from 'expensify-common/CLI';

import CollectionUtils from './libs/CollectionUtils';
import GitCommitUtils, {type GitHubPullRequestCommit} from './libs/GitCommitUtils';
import GitHubUtils from './libs/GitHubUtils';
import GitHubWorkflowUtils from './libs/GitHubWorkflowUtils';

type PeerReviewInput = {
    owner: string;
    repo: string;
    number: number;
    baseRef: string;
    requiredApprovingReviewCount: number;
    approvers: string[];
    authors: string[];
    unresolvedExpensifyCoAuthors: string[];
    employeeLogins: Set<string>;
};

type PeerReviewResult = {status: 'pass'; reason: string} | {status: 'skip'; reason: string} | {status: 'fail'; error: Error};

function formatUsers(users: string[]): string {
    return users.length > 0 ? users.join(', ') : '(none)';
}

function isExpensifyEmail(email: string): boolean {
    return email.trim().toLowerCase().endsWith('@expensify.com');
}

function getCommitAuthors(
    commits: GitHubPullRequestCommit[],
    employeeLogins?: Set<string>,
): {
    authors: string[];
    unresolvedExpensifyCoAuthors: string[];
} {
    const authors = new Set<string>();
    const unresolvedExpensifyCoAuthors = new Set<string>();

    for (const commit of commits) {
        const canonicalAuthor = GitCommitUtils.getCanonicalAuthorLogin(commit);
        authors.add(canonicalAuthor);

        // Co-authorship between two humans from making and accepting a suggestion does not violate peer review.
        // Only parse co-authors when the canonical commit author is a bot.
        if (!GitHubUtils.isBotUser(canonicalAuthor)) {
            continue;
        }

        for (const coAuthor of GitCommitUtils.parseCoAuthors(commit.commit.message)) {
            const login = GitCommitUtils.resolveCoAuthorToLogin(coAuthor, employeeLogins);
            if (login) {
                authors.add(login);
            } else if (isExpensifyEmail(coAuthor.email)) {
                unresolvedExpensifyCoAuthors.add(coAuthor.email.trim());
            }
        }
    }

    return {
        authors: CollectionUtils.uniqueSorted([...authors]),
        unresolvedExpensifyCoAuthors: CollectionUtils.uniqueSorted([...unresolvedExpensifyCoAuthors]),
    };
}

function getIndependentEmployeeApprovers(approvers: string[], authors: string[], employeeLogins: Set<string>): string[] {
    const authorSet = new Set(authors);
    return approvers.filter((approver) => !authorSet.has(approver) && employeeLogins.has(approver));
}

function evaluatePeerReview(input: PeerReviewInput): PeerReviewResult {
    const {owner, repo, number, baseRef, requiredApprovingReviewCount, approvers, authors, unresolvedExpensifyCoAuthors, employeeLogins} = input;
    const prSlug = `${owner}/${repo}#${number}`;

    if (requiredApprovingReviewCount === 0) {
        return {
            status: 'skip',
            reason: `${prSlug} targets ${baseRef}, which does not require approving reviews.`,
        };
    }

    if (approvers.length === 0) {
        return {
            status: 'skip',
            reason: `${prSlug} has no approving reviews from writers; regular branch protection will block merge until an approval exists.`,
        };
    }

    if (unresolvedExpensifyCoAuthors.length > 0) {
        return {
            status: 'fail',
            error: new Error(`Unable to resolve Expensify co-author emails to GitHub users: ${formatUsers(unresolvedExpensifyCoAuthors)}`),
        };
    }

    if (authors.every((author) => GitHubUtils.isBotUser(author))) {
        return {
            status: 'fail',
            error: new Error(`Unable to verify independent peer review because ${prSlug} has no human commit authors or co-authors.`),
        };
    }

    const independentEmployeeApprovers = getIndependentEmployeeApprovers(approvers, authors, employeeLogins);
    if (independentEmployeeApprovers.length < requiredApprovingReviewCount) {
        return {
            status: 'fail',
            error: new Error(
                [
                    `${prSlug} does not have enough independent Expensify employee approvals.`,
                    `Required independent approvals: ${requiredApprovingReviewCount}`,
                    `Commit authors/co-authors: ${formatUsers(authors)}`,
                    `Approvers: ${formatUsers(approvers)}`,
                    `Independent employee approvers: ${formatUsers(independentEmployeeApprovers)}`,
                ].join('\n'),
            ),
        };
    }

    return {
        status: 'pass',
        reason: `${prSlug} has ${independentEmployeeApprovers.length} independent Expensify employee approval(s).`,
    };
}

function getFailureTitle(message: string): string {
    if (message.includes('does not have enough independent Expensify employee approvals')) {
        return 'Missing independent peer review';
    }
    if (message.includes('Unable to resolve Expensify co-author emails')) {
        return 'Unresolved Expensify co-author';
    }
    if (message.includes('Unable to resolve canonical commit author')) {
        return 'Missing commit author';
    }
    if (message.includes('has no human commit authors or co-authors')) {
        return 'No human commit author';
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
            'base-ref': {
                description: 'Target branch ref for the pull request',
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const owner = cli.namedArgs.owner;
    const repo = cli.namedArgs.repo;
    const pullRequestNumber = cli.namedArgs['pull-request-number'];
    const baseRef = cli.namedArgs['base-ref'];

    const [requiredApprovingReviewCount, approvers, commits] = await Promise.all([
        GitHubUtils.getRequiredApprovingReviewCount({owner, repo, baseRef}),
        GitHubUtils.getLatestApprovers({owner, repo, number: pullRequestNumber}),
        GitHubUtils.listPullRequestCommits({
            owner,
            repo,
            number: pullRequestNumber,
        }),
    ]);

    const employeeLogins = requiredApprovingReviewCount > 0 ? await GitHubUtils.getEmployeeLogins() : new Set<string>();
    const {authors, unresolvedExpensifyCoAuthors} = getCommitAuthors(commits, employeeLogins);

    const result = evaluatePeerReview({
        owner,
        repo,
        number: pullRequestNumber,
        baseRef,
        requiredApprovingReviewCount,
        approvers,
        authors,
        unresolvedExpensifyCoAuthors,
        employeeLogins,
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
