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

export default getEmployeeLogins;
