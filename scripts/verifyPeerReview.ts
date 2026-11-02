#!/usr/bin/env -S node --import tsx

import CLI from 'expensify-common/CLI';

import CollectionUtils from './libs/CollectionUtils';
import GitCommitUtils, {type GitHubPullRequestCommit} from './libs/GitCommitUtils';
import GitHubAPIClient from './libs/GitHubAPIClient';
import createGitHubUtils from './libs/GitHubUtils';
import type {ActorType, GitHubUtils} from './libs/GitHubUtils';
import {parseLatestApprovers, type OpinionatedReviewNode} from './libs/GitHubUtils/getLatestApprovers';
import {BRANCH_PROTECTION_FIELDS, parseRequiredApprovingReviewCount, type BranchProtectionResponse} from './libs/GitHubUtils/getRequiredApprovingReviewCount';
import isPermissionError from './libs/GitHubUtils/isPermissionError';
import GitHubWorkflowUtils, {WorkflowError} from './libs/GitHubWorkflowUtils';

type PeerReviewInput = {
    owner: string;
    repo: string;
    prNumber: number;
    targetBranch: string;
    actorType: ActorType;
};

type PeerReviewResult = {status: 'pass'; reason: string} | {status: 'fail'; error: Error};

type PeerReviewCommit = GitHubPullRequestCommit & {authorLoginsByEmail: Map<string, string>};
type PeerReviewData = {
    requiredApprovingReviewCount: number;
    commitCount: number;
    commits: PeerReviewCommit[];
    approvers: string[];
};
type CommitNode = {
    commit: {
        oid: string;
        message: string;
        author: {name: string | null; user: {login: string} | null} | null;
        authors: {
            nodes: Array<{email: string; user: {login: string} | null}>;
            pageInfo: {hasNextPage: boolean};
        };
    };
};
type PeerReviewResponse = {
    repository:
        | (NonNullable<BranchProtectionResponse['repository']> & {
              pullRequest: {
                  headRefOid: string;
                  commits: {
                      totalCount: number;
                      nodes: CommitNode[];
                      pageInfo: {hasNextPage: boolean; endCursor: string | null};
                  };
                  latestOpinionatedReviews?: {nodes: OpinionatedReviewNode[]};
              } | null;
          })
        | null;
};

type PeerReviewReadArgs = {owner: string; repo: string; number: number; baseRef: string; expectedHeadSHA: string};
type ApprovalsResponse = {
    repository: {
        pullRequest: {
            headRefOid: string;
            latestOpinionatedReviews: {nodes: OpinionatedReviewNode[]} | null;
        } | null;
    } | null;
};

const EXPENSIFY_EMPLOYEE_TEAM_SLUG = 'expensify-expensify';
const REPOSITORY_REVIEWER_TEAMS = new Map([
    ['Expensify/react-native-wallet', ['react-native-wallet-writers']],
    ['Expensify/react-native-live-markdown', ['react-native-live-markdown-writers', 'react-native-live-markdown-maintainers']],
]);

function assertExpectedHead(headSHA: string, {owner, repo, number, expectedHeadSHA}: PeerReviewReadArgs): void {
    if (headSHA !== expectedHeadSHA) {
        throw new WorkflowError({
            title: 'Pull request changed',
            message: `${owner}/${repo}#${number} no longer has the expected head ${expectedHeadSHA}. Please rerun the check for its current head.`,
        });
    }
}

async function getPeerReviewData(client: GitHubAPIClient, args: PeerReviewReadArgs): Promise<PeerReviewData> {
    const {owner, repo, number, baseRef} = args;
    const commits: PeerReviewCommit[] = [];
    let cursor: string | null = null;
    let requiredApprovingReviewCount = 0;
    let approvers: string[] = [];
    let commitCount = 0;

    do {
        const isFirstPage = cursor === null;
        let response: PeerReviewResponse;
        try {
            // The first page includes protection and approvals; subsequent pages fetch commits and the current head.
            // eslint-disable-next-line no-await-in-loop
            response = await client.graphql<PeerReviewResponse>(
                `query PeerReviewData($owner: String!, $repo: String!, $prNumber: Int!, $branchRef: String!, $cursor: String, $includeMetadata: Boolean!) {
                    repository(owner: $owner, name: $repo) {
                        ref(qualifiedName: $branchRef) @include(if: $includeMetadata) {
                            ${BRANCH_PROTECTION_FIELDS}
                        }
                        pullRequest(number: $prNumber) {
                            headRefOid
                            commits(first: 100, after: $cursor) {
                                totalCount
                                nodes {
                                    commit {
                                        oid
                                        message
                                        author {
                                            name
                                            user { login }
                                        }
                                        authors(first: 100) {
                                            nodes {
                                                email
                                                user { login }
                                            }
                                            pageInfo { hasNextPage }
                                        }
                                    }
                                }
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                            }
                            latestOpinionatedReviews(last: 100, writersOnly: true) @include(if: $includeMetadata) {
                                nodes {
                                    state
                                    author { login }
                                }
                            }
                        }
                    }
                }`,
                {owner, repo, prNumber: number, branchRef: `refs/heads/${baseRef}`, cursor, includeMetadata: isFirstPage},
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new WorkflowError({
                title: 'Peer review lookup failed',
                message: isPermissionError(error)
                    ? `Unable to read peer review data for ${owner}/${repo}#${number}. Ensure the GitHub App has administration:read and pull_requests:read permissions.`
                    : `Unable to read peer review data for ${owner}/${repo}#${number}: ${message}`,
            });
        }

        if (isFirstPage) {
            requiredApprovingReviewCount = parseRequiredApprovingReviewCount(response, args);
        }

        const pullRequest = response.repository?.pullRequest;
        if (!pullRequest) {
            throw new WorkflowError({title: 'Unknown pull request', message: `Pull request ${owner}/${repo}#${number} could not be found.`});
        }
        assertExpectedHead(pullRequest.headRefOid, args);
        if (requiredApprovingReviewCount === 0) {
            return {requiredApprovingReviewCount, commitCount: 0, commits: [], approvers: []};
        }

        const page = pullRequest.commits;
        if (isFirstPage) {
            commitCount = page.totalCount;
            if (!pullRequest.latestOpinionatedReviews) {
                throw new WorkflowError({title: 'Missing reviews', message: `No review data returned for ${owner}/${repo}#${number}.`});
            }
            approvers = parseLatestApprovers(pullRequest.latestOpinionatedReviews.nodes);
        }

        for (const {commit} of page.nodes) {
            if (commit.authors.pageInfo.hasNextPage) {
                throw new WorkflowError({title: 'Too many commit authors', message: `Commit ${commit.oid} has more than 100 authors, so its authorship can't be reliably verified.`});
            }
            const authorLoginsByEmail = new Map<string, string>();
            for (const {email, user} of commit.authors.nodes) {
                if (user) {
                    authorLoginsByEmail.set(email.toLowerCase(), user.login);
                }
            }
            commits.push({sha: commit.oid, author: commit.author?.user ?? null, commit: {message: commit.message, author: commit.author}, authorLoginsByEmail});
        }

        if (page.totalCount !== commitCount || commits.length > commitCount) {
            throw new WorkflowError({title: 'Incomplete commit data', message: `Commit count changed while reading ${owner}/${repo}#${number}. Please rerun the check.`});
        }
        if (!page.pageInfo.hasNextPage) {
            break;
        }
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor || page.nodes.length === 0 || commits.length >= commitCount) {
            throw new WorkflowError({title: 'Incomplete commit data', message: `Unable to paginate all commits for ${owner}/${repo}#${number}.`});
        }
        cursor = page.pageInfo.endCursor;
    } while (cursor);

    if (commits.length !== commitCount) {
        throw new WorkflowError({title: 'Incomplete commit data', message: `Expected ${commitCount} commits for ${owner}/${repo}#${number}, but received ${commits.length}.`});
    }
    if (commits.length > 0) {
        assertExpectedHead(commits.at(-1)?.sha ?? '', args);
    }

    // Pagination spans multiple requests, so approvals must be read after the full commit set is collected.
    if (cursor !== null) {
        const response = await client.graphql<ApprovalsResponse>(
            `query PeerReviewApprovals($owner: String!, $repo: String!, $prNumber: Int!) {
                repository(owner: $owner, name: $repo) {
                    pullRequest(number: $prNumber) {
                        headRefOid
                        latestOpinionatedReviews(last: 100, writersOnly: true) {
                            nodes {
                                state
                                author { login }
                            }
                        }
                    }
                }
            }`,
            {owner, repo, prNumber: number},
        );
        const pullRequest = response.repository?.pullRequest;
        if (!pullRequest) {
            throw new WorkflowError({title: 'Unknown pull request', message: `Pull request ${owner}/${repo}#${number} could not be found.`});
        }
        assertExpectedHead(pullRequest.headRefOid, args);
        if (!pullRequest.latestOpinionatedReviews) {
            throw new WorkflowError({title: 'Missing reviews', message: `No review data returned for ${owner}/${repo}#${number}.`});
        }
        approvers = parseLatestApprovers(pullRequest.latestOpinionatedReviews.nodes);
    }
    return {requiredApprovingReviewCount, commitCount, commits, approvers};
}

function getCommitAuthors(gitHubUtils: GitHubUtils, commits: PeerReviewCommit[], actorType: ActorType): string[] {
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

        const unresolvedCoAuthorEmails: string[] = [];
        for (const coAuthorEmail of GitCommitUtils.parseCoAuthorEmails(commit.commit.message)) {
            const login = GitCommitUtils.resolveNoreplyEmailToLogin(coAuthorEmail);
            if (login) {
                authors.add(login);
            } else {
                unresolvedCoAuthorEmails.push(coAuthorEmail);
            }
        }

        if (unresolvedCoAuthorEmails.length === 0) {
            continue;
        }

        for (const coAuthorEmail of unresolvedCoAuthorEmails) {
            const login = commit.authorLoginsByEmail.get(coAuthorEmail.toLowerCase());
            if (!login) {
                throw new WorkflowError({title: 'Unresolved co-author', message: `Unable to resolve co-author email to GitHub user: ${coAuthorEmail}`});
            }

            console.log('Resolved co-author email through GitHub commit authors', {
                commitSHA: commit.sha,
                coAuthorEmail,
                login,
            });
            authors.add(login);
        }
    }

    return CollectionUtils.uniqueSorted([...authors]);
}

async function getIndependentApprovers(gitHubUtils: GitHubUtils, approvers: string[], authors: string[], owner: string, repo: string): Promise<string[]> {
    const authorsSet = new Set(authors);
    const independentApprovers = approvers.filter((approver) => !authorsSet.has(approver));
    const reviewerTeams = [EXPENSIFY_EMPLOYEE_TEAM_SLUG, ...(REPOSITORY_REVIEWER_TEAMS.get(`${owner}/${repo}`) ?? [])];
    const eligibleReviewers = await gitHubUtils.getTeamMemberLogins(reviewerTeams, independentApprovers);

    return independentApprovers.filter((approver) => eligibleReviewers.has(approver));
}

async function evaluatePeerReview(gitHubUtils: GitHubUtils, input: PeerReviewInput, data: PeerReviewData): Promise<PeerReviewResult> {
    const {owner, repo, prNumber, targetBranch, actorType} = input;
    const prSlug = `${owner}/${repo}#${prNumber}`;

    const {requiredApprovingReviewCount, commits, approvers} = data;
    if (requiredApprovingReviewCount === 0) {
        return {
            status: 'pass',
            reason: `${prSlug} targets ${targetBranch}, which does not require approving reviews.`,
        };
    }

    const authors = getCommitAuthors(gitHubUtils, commits, actorType);

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

async function main(clientOverride?: GitHubAPIClient): Promise<void> {
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
            'head-sha': {
                description: 'Expected pull request head SHA from the triggering workflow event',
                parse: (value: string) => {
                    if (!/^[a-f0-9]{40}$/.test(value)) {
                        throw new Error('Must be a 40-character hexadecimal commit SHA');
                    }
                    return value;
                },
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
    const expectedHeadSHA = cli.namedArgs['head-sha'];

    console.log('Evaluating PR', {
        repo,
        prNumber: pullRequestNumber,
        targetBranch,
        htmlURL: `https://github.com/${owner}/${repo}/pull/${pullRequestNumber}`,
    });

    const client = clientOverride ?? GitHubAPIClient.fromEnv();
    const data = await getPeerReviewData(client, {owner, repo, number: pullRequestNumber, baseRef: targetBranch, expectedHeadSHA});
    const result = await evaluatePeerReview(
        createGitHubUtils(client),
        {
            owner,
            repo,
            prNumber: pullRequestNumber,
            targetBranch,
            actorType,
        },
        data,
    );

    if (result.status === 'pass') {
        console.log(result.reason);
        return;
    }

    throw result.error;
}

export type {PeerReviewInput, PeerReviewResult, PeerReviewCommit, PeerReviewData};

export default {
    main,
    evaluatePeerReview,
    getIndependentApprovers,
    getCommitAuthors,
    getPeerReviewData,
};

if (import.meta.main) {
    main().catch((error) => {
        GitHubWorkflowUtils.emitFailure(error, 'Peer review verification failed');
    });
}
