import type GitHubAPIClient from '../GitHubAPIClient';
import {createGraphQLVariable} from '../GitHubAPIClient';
import type {GraphQLVariable} from '../GitHubAPIClient';

const EXPENSIFY_ORG = 'Expensify';

type MembershipSearch = {
    login: string;
    alias: string;
    cursor: string | null;
};

type TeamMemberPage = {
    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
    };
    nodes: Array<{login: string}>;
};

type TeamMembersResponse = {
    organization: {
        team: Record<string, TeamMemberPage> | null;
    } | null;
};

/**
 * Returns the candidate logins that belong to a team, batching their searches into one request per page.
 */
async function getTeamMemberLogins(client: GitHubAPIClient, teamSlug: string, candidateLogins: string[]): Promise<Set<string>> {
    const teamMemberLogins = new Set<string>();
    let pendingSearches: MembershipSearch[] = [];

    // Each candidate gets a stable GraphQL alias so we can identify their results in the response.
    // Logins can't be used as GraphQL aliases because they may contain hyphens
    const uniqueLogins = new Set(candidateLogins);
    for (const login of uniqueLogins) {
        pendingSearches.push({
            login,
            alias: `member${pendingSearches.length}`,
            cursor: null,
        });
    }

    while (pendingSearches.length > 0) {
        const organizationVariable = createGraphQLVariable('organization', EXPENSIFY_ORG, 'String!');
        const teamSlugVariable = createGraphQLVariable('teamSlug', teamSlug, 'String!');
        const queryVariables: GraphQLVariable[] = [organizationVariable, teamSlugVariable];
        const memberQueries: string[] = [];

        // Build one request containing a separate team-member search for each pending login.
        for (const search of pendingSearches) {
            const loginVariable = createGraphQLVariable(search.alias, search.login, 'String!');
            const cursorVariable = createGraphQLVariable(`${search.alias}Cursor`, search.cursor, 'String');
            queryVariables.push(loginVariable, cursorVariable);

            memberQueries.push(`
                ${search.alias}: members(first: 100, query: ${loginVariable.reference}, after: ${cursorVariable.reference}) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    nodes {
                        login
                    }
                }
            `);
        }

        const variables: Record<string, string | null> = {};
        const variableDeclarations: Array<GraphQLVariable['declaration']> = [];
        for (const variable of queryVariables) {
            variables[variable.name] = variable.value;
            variableDeclarations.push(variable.declaration);
        }

        const query = `
            query TeamMembers(${variableDeclarations.join(', ')}) {
                organization(login: ${organizationVariable.reference}) {
                    team(slug: ${teamSlugVariable.reference}) {
                        ${memberQueries.join('\n')}
                    }
                }
            }
        `;

        // Each subsequent request depends on the cursors returned by the previous page.
        // eslint-disable-next-line no-await-in-loop
        const response = await client.graphql<TeamMembersResponse>(query, variables);
        const team = response.organization?.team;
        if (!team) {
            throw new Error(`${EXPENSIFY_ORG}/${teamSlug} team could not be found.`);
        }

        const nextPageSearches: MembershipSearch[] = [];
        for (const search of pendingSearches) {
            const members = team[search.alias];
            if (!members) {
                throw new Error(`Missing team membership search result for ${search.login}.`);
            }

            // GitHub's query is a fuzzy search, so only an exact login match proves membership.
            let foundExactMatch = false;
            for (const member of members.nodes) {
                if (member.login === search.login) {
                    foundExactMatch = true;
                    break;
                }
            }

            if (foundExactMatch) {
                teamMemberLogins.add(search.login);
                continue;
            }
            if (!members.pageInfo.hasNextPage) {
                continue;
            }
            if (!members.pageInfo.endCursor || members.pageInfo.endCursor === search.cursor) {
                throw new Error(`Missing or repeated team membership cursor for ${search.login}.`);
            }
            // We haven't found this login yet, but there are more results to check.
            nextPageSearches.push({
                login: search.login,
                alias: search.alias,
                cursor: members.pageInfo.endCursor,
            });
        }

        pendingSearches = nextPageSearches;
    }

    return teamMemberLogins;
}

export default getTeamMemberLogins;
