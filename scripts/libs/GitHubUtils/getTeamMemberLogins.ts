import type GitHubAPIClient from '../GitHubAPIClient';

const EXPENSIFY_ORG = 'Expensify';

type TeamMembersResponse = {
    organization: {
        team: Record<
            string,
            {
                pageInfo: {hasNextPage: boolean; endCursor: string | null};
                nodes: Array<{login: string}>;
            }
        > | null;
    } | null;
};

/**
 * Returns the candidate logins that belong to a team, batching their searches into one request per page.
 */
async function getTeamMemberLogins(client: GitHubAPIClient, teamSlug: string, candidateLogins: string[]): Promise<Set<string>> {
    const teamMemberLogins = new Set<string>();
    let searches = [...new Set(candidateLogins)].map((login, index) => ({login, alias: `member${index}`, cursor: null as string | null}));

    while (searches.length > 0) {
        const variables: Record<string, string | null> = {organization: EXPENSIFY_ORG, teamSlug};
        const declarations = searches.map(({alias, login, cursor}) => {
            variables[alias] = login;
            variables[`${alias}Cursor`] = cursor;
            return `$${alias}: String!, $${alias}Cursor: String`;
        });
        const fields = searches.map(
            ({alias}) => `
            ${alias}: members(first: 100, query: $${alias}, after: $${alias}Cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { login }
            }
        `,
        );

        // Each subsequent request depends on the cursors returned by the previous page.
        // eslint-disable-next-line no-await-in-loop
        const response = await client.graphql<TeamMembersResponse>(
            `query TeamMembers($organization: String!, $teamSlug: String!, ${declarations.join(', ')}) {
                organization(login: $organization) {
                    team(slug: $teamSlug) { ${fields.join('\n')} }
                }
            }`,
            variables,
        );
        const team = response.organization?.team;
        if (!team) {
            throw new Error(`${EXPENSIFY_ORG}/${teamSlug} team could not be found.`);
        }

        searches = searches.flatMap((search) => {
            const members = team[search.alias];
            if (!members) {
                throw new Error(`Missing team membership search result for ${search.login}.`);
            }
            // GitHub's query is a fuzzy search, so only an exact login match proves membership.
            if (members.nodes.some(({login}) => login === search.login)) {
                teamMemberLogins.add(search.login);
                return [];
            }
            if (!members.pageInfo.hasNextPage) {
                return [];
            }
            if (!members.pageInfo.endCursor || members.pageInfo.endCursor === search.cursor) {
                throw new Error(`Missing or repeated team membership cursor for ${search.login}.`);
            }
            return [{...search, cursor: members.pageInfo.endCursor}];
        });
    }

    return teamMemberLogins;
}

export default getTeamMemberLogins;
