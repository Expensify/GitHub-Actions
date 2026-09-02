import type GitHubAPIClient from '../GitHubAPIClient';

const EXPENSIFY_ORG = 'Expensify';

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

const teamMemberLoginsPromisesByClient = new WeakMap<GitHubAPIClient, Map<string, Promise<Set<string>>>>();

/**
 * Fetches and memoizes all members of a GitHub team for the lifetime of a client.
 */
async function getTeamMemberLogins(client: GitHubAPIClient, teamSlug: string): Promise<Set<string>> {
    let teamPromises = teamMemberLoginsPromisesByClient.get(client);
    if (!teamPromises) {
        teamPromises = new Map();
        teamMemberLoginsPromisesByClient.set(client, teamPromises);
    }

    let teamMembersPromise = teamPromises.get(teamSlug);
    if (!teamMembersPromise) {
        teamMembersPromise = fetchTeamMemberLogins(client, teamSlug);
        teamPromises.set(teamSlug, teamMembersPromise);
    }

    return teamMembersPromise;
}

async function fetchTeamMemberLogins(client: GitHubAPIClient, teamSlug: string): Promise<Set<string>> {
    const teamMemberLogins = new Set<string>();
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
                teamSlug,
                cursor,
            },
        );

        const members = response.organization?.team?.members;
        if (!members) {
            throw new Error(`${EXPENSIFY_ORG}/${teamSlug} team could not be found.`);
        }

        for (const member of members.nodes) {
            teamMemberLogins.add(member.login);
        }

        hasNextPage = members.pageInfo.hasNextPage;
        cursor = members.pageInfo.endCursor;
    }

    return teamMemberLogins;
}

export default getTeamMemberLogins;
