import type GitHubAPIClient from '../GitHubAPIClient';

const EXPENSIFY_ORG = 'Expensify';
const EXPENSIFY_EMPLOYEE_TEAM_SLUG = 'expensify-expensify';

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

// Memoize the employee fetch list per client so that it happens at most once per client.
const employeeLoginsPromisesByClient = new WeakMap<GitHubAPIClient, Promise<Set<string>>>();

/**
 * This exists largely to replace Web-Expensify's Whitelist lookup, which we can't directly replace in open source.
 * So our authoritative source for "is this an Expensify employee" is this GitHub Team
 * which is meant to include all Expensify employees: https://github.com/orgs/Expensify/teams/expensify-expensify
 */
async function getEmployeeLogins(client: GitHubAPIClient): Promise<Set<string>> {
    let employeeLoginsPromise = employeeLoginsPromisesByClient.get(client);
    if (!employeeLoginsPromise) {
        employeeLoginsPromise = fetchEmployeeLogins(client);
        employeeLoginsPromisesByClient.set(client, employeeLoginsPromise);
    }

    return employeeLoginsPromise;
}

async function fetchEmployeeLogins(client: GitHubAPIClient): Promise<Set<string>> {
    const employeeLogins = new Set<string>();

    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
        // await-in-loop is necessary and appropriate for polling a paginated endpoint;
        // each request is dependent upon the response of the previous.
        // eslint-disable-next-line no-await-in-loop
        const response: TeamMembersResponse = await client.graphql<TeamMembersResponse>(
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

        hasNextPage = members.pageInfo.hasNextPage;
        cursor = members.pageInfo.endCursor;
    }

    return employeeLogins;
}

async function isExpensifyEmployee(client: GitHubAPIClient, login: string): Promise<boolean> {
    const employeeLogins = await getEmployeeLogins(client);
    return employeeLogins.has(login);
}

export default getEmployeeLogins;
export {isExpensifyEmployee};
