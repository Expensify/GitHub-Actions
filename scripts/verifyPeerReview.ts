#!/usr/bin/env -S node --import tsx

import CLI from 'expensify-common/CLI';

import CollectionUtils from './libs/CollectionUtils';
import GitCommitUtils from './libs/GitCommitUtils';
import GitHubUtils from './libs/GitHubUtils';
import GitHubWorkflowUtils from './libs/GitHubWorkflowUtils';

type PeerReviewInput = {
    owner: string;
    repo: string;
    prNumber: number;
    targetBranch: string;
};

type PeerReviewResult = {status: 'pass'; reason: string} | {status: 'skip'; reason: string} | {status: 'fail'; error: Error};

function formatUsers(users: string[]): string {
    return users.length > 0 ? users.join(', ') : '(none)';
}

async function getCommitAuthors({owner, repo, prNumber}: {owner: string; repo: string; prNumber: number}): Promise<{
    authors: string[];
    unresolvedCoAuthors: string[];
}> {
    const [commits, employeeLogins] = await Promise.all([GitHubUtils.listPullRequestCommits({owner, repo, number: prNumber}), GitHubUtils.getEmployeeLogins()]);

    const authors = new Set<string>();
    const unresolvedCoAuthors = new Set<string>();

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
            } else {
                unresolvedCoAuthors.add(coAuthor.email.trim());
            }
        }
    }

    return {
        authors: CollectionUtils.uniqueSorted([...authors]),
        unresolvedCoAuthors: CollectionUtils.uniqueSorted([...unresolvedCoAuthors]),
    };
}

async function getIndependentEmployeeApprovers(approvers: string[], authors: string[]): Promise<string[]> {
    const authorsSet = new Set(authors);
    const independentApprovers = approvers.filter((approver) => !authorsSet.has(approver));
    return CollectionUtils.filterAsync(independentApprovers, (approver) => GitHubUtils.isExpensifyEmployee(approver));
}

async function evaluatePeerReview(input: PeerReviewInput): Promise<PeerReviewResult> {
    const {owner, repo, prNumber, targetBranch} = input;
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

    const {authors, unresolvedCoAuthors} = await getCommitAuthors({owner, repo, prNumber});

    // Unlike the PHP chore, which logs a bugbot and skips when no commit authors can be determined,
    // we fail the check here so an unresolvable PR can't merge without independent review.
    if (authors.length === 0) {
        return {
            status: 'fail',
            error: new Error(`Unable to determine any commit authors for ${prSlug}.`),
        };
    }

    // If we can't determine who co-authored a commit,
    // then it's possible they're the same person who approved; block merge
    if (unresolvedCoAuthors.length > 0) {
        return {
            status: 'fail',
            error: new Error(`Unable to resolve co-author emails to GitHub users: ${formatUsers(unresolvedCoAuthors)}`),
        };
    }

    if (authors.every((author) => GitHubUtils.isBotUser(author))) {
        console.error('All commit authors are bots', {
            authors,
            requiredApprovingReviewCount,
        });
        return {
            status: 'fail',
            error: new Error('All commit authors are bots'),
        };
    }

    const approvers = await GitHubUtils.getLatestApprovers({owner, repo, number: prNumber});
    const independentEmployeeApprovers = await getIndependentEmployeeApprovers(approvers, authors);
    if (independentEmployeeApprovers.length >= requiredApprovingReviewCount) {
        return {
            status: 'pass',
            reason: `${prSlug} has ${independentEmployeeApprovers.length} independent Expensify employee approval(s).`,
        };
    }

    console.error('Insufficient independent peer review', {
        commitAuthors: authors,
        approvers,
        independentApprovers: independentEmployeeApprovers,
        required: requiredApprovingReviewCount,
    });
    return {
        status: 'fail',
        error: new Error(`${prSlug} does not have enough independent Expensify employee approvals.`),
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
    if (message.includes('All commit authors are bots')) {
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
            'target-branch': {
                description: 'Target branch ref for the pull request',
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const owner = cli.namedArgs.owner;
    const repo = cli.namedArgs.repo;
    const pullRequestNumber = cli.namedArgs['pull-request-number'];
    const targetBranch = cli.namedArgs['target-branch'];

    const result = await evaluatePeerReview({
        owner,
        repo,
        prNumber: pullRequestNumber,
        targetBranch,
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
