import GitHubAPIClient from '../GitHubAPIClient';

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

let employeeLoginsPromise: Promise<Set<string>> | undefined;

/**
 * This exists largely to replace Web-Expensify's Whitelist lookup, which we can't directly replace in open source.
 * So our authoritative source for "is this an Expensify employee" is this GitHub Team
 * which is meant to include all Expensify employees: https://github.com/orgs/Expensify/teams/expensify-expensify
 */
async function getEmployeeLogins(): Promise<Set<string>> {
    // Memoize the employee fetch list so that it happens at most once
    if (!employeeLoginsPromise) {
        employeeLoginsPromise = fetchEmployeeLogins();
    }

    return employeeLoginsPromise;
}

async function fetchEmployeeLogins(): Promise<Set<string>> {
    const employeeLogins = new Set<string>();

    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
        // eslint-disable-next-line no-await-in-loop
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

        hasNextPage = members.pageInfo.hasNextPage;
        cursor = members.pageInfo.endCursor;
    }

    return employeeLogins;
}

async function isExpensifyEmployee(login: string): Promise<boolean> {
    const employeeLogins = await getEmployeeLogins();
    return employeeLogins.has(login);
}

export default getEmployeeLogins;
export {isExpensifyEmployee};
