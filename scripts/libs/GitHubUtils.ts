import {RequestError} from '@octokit/request-error';
import GitHubAPIClient from './GitHubAPIClient';

const DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT = 1;
const EXPENSIFY_ORG = 'Expensify';
const EXPENSIFY_EMPLOYEE_TEAM_SLUG = 'expensify-expensify';

type BranchProtectionResponse = {
    repository: {
        ref: {
            branchProtectionRule: {
                requiredApprovingReviewCount: number;
            } | null;
        } | null;
    } | null;
};

type OpinionatedReviewNode = {
    state: string;
    author: {
        login: string;
    } | null;
};

type LatestOpinionatedReviewsResponse = {
    repository: {
        pullRequest: {
            latestOpinionatedReviews: {
                nodes: OpinionatedReviewNode[];
            };
        } | null;
    } | null;
};

type TeamMembersResponse = {
    organization: {
        team: {
            members: {
                pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
                nodes: Array<{
                    login: string;
                }>;
            };
        } | null;
    } | null;
};

type GraphQLErrorResponse = {
    errors?: Array<{
        type?: string;
        message?: string;
    }>;
};

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isGraphQLErrorResponse(error: unknown): error is GraphQLErrorResponse {
    return typeof error === 'object' && error !== null && 'errors' in error;
}

function isPermissionError(error: unknown): boolean {
    if (error instanceof RequestError) {
        return error.status === 401 || error.status === 403;
    }

    if (isGraphQLErrorResponse(error)) {
        const {errors} = error;
        return errors?.some((graphQLError) => graphQLError.type === 'FORBIDDEN' || graphQLError.type === 'INSUFFICIENT_SCOPES') ?? false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /resource not accessible by integration|must have admin access|insufficient scopes|permission denied/i.test(message);
}

async function getRequiredApprovingReviewCount({owner, repo, baseRef}: {owner: string; repo: string; baseRef: string}): Promise<number> {
    try {
        const response = await GitHubAPIClient.graphql<BranchProtectionResponse>(
            `
            query RequiredApprovingReviewCount($owner: String!, $repo: String!, $branchRef: String!) {
                repository(owner: $owner, name: $repo) {
                    ref(qualifiedName: $branchRef) {
                        branchProtectionRule {
                            requiredApprovingReviewCount
                        }
                    }
                }
            }
        `,
            {
                owner,
                repo,
                branchRef: `refs/heads/${baseRef}`,
            },
        );

        return response.repository?.ref?.branchProtectionRule?.requiredApprovingReviewCount ?? 0;
    } catch (error: unknown) {
        if (isPermissionError(error)) {
            throw new Error(`Unable to read branch protection rules for ${owner}/${repo}@${baseRef}. Ensure the GitHub App has administration:read permission.`);
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `${owner}/${repo}@${baseRef} did not return a branch protection review count (${message}); requiring ${DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT} independent approval(s).`,
        );
        return DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT;
    }
}

async function getLatestApprovers({owner, repo, number}: {owner: string; repo: string; number: number}): Promise<string[]> {
    const response = await GitHubAPIClient.graphql<LatestOpinionatedReviewsResponse>(
        `
        query LatestOpinionatedReviews($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                    latestOpinionatedReviews(last: 100, writersOnly: true) {
                        nodes {
                            state
                            author {
                                login
                            }
                        }
                    }
                }
            }
        }
    `,
        {
            owner,
            repo,
            prNumber: number,
        },
    );

    const reviews: OpinionatedReviewNode[] = response.repository?.pullRequest?.latestOpinionatedReviews.nodes ?? [];
    return uniqueSorted(
        reviews
            .filter((review) => review.state === 'APPROVED')
            .map((review) => review.author?.login ?? '')
            .filter((login) => login !== ''),
    );
}

async function getEmployeeLogins(): Promise<Set<string>> {
    const employeeLogins = new Set<string>();

    async function collectPage(cursor: string | null): Promise<void> {
        const response: TeamMembersResponse = await GitHubAPIClient.graphql<TeamMembersResponse>(
            `
            query TeamMembers($organization: String!, $teamSlug: String!, $cursor: String) {
                organization(login: $organization) {
                    team(slug: $teamSlug) {
                        members(first: 100, after: $cursor) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            nodes {
                                login
                            }
                        }
                    }
                }
            }
        `,
            {
                organization: EXPENSIFY_ORG,
                teamSlug: EXPENSIFY_EMPLOYEE_TEAM_SLUG,
                cursor,
            },
        );

        const members = response.organization?.team?.members;
        if (!members) {
            throw new Error(`${EXPENSIFY_ORG}/${EXPENSIFY_EMPLOYEE_TEAM_SLUG} team could not be found.`);
        }

        for (const member of members.nodes) {
            employeeLogins.add(member.login);
        }

        if (members.pageInfo.hasNextPage) {
            await collectPage(members.pageInfo.endCursor);
        }
    }

    await collectPage(null);
    return employeeLogins;
}

async function listPullRequestCommits({owner, repo, number}: {owner: string; repo: string; number: number}) {
    return GitHubAPIClient.paginate(GitHubAPIClient.octokit.pulls.listCommits, {
        owner,
        repo,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        pull_number: number,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        per_page: 100,
    });
}

export default {
    getEmployeeLogins,
    getLatestApprovers,
    getRequiredApprovingReviewCount,
    listPullRequestCommits,
};
