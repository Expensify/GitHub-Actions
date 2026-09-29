import type GitHubAPIClient from '../GitHubAPIClient';
import {createGraphQLVariable} from '../GitHubAPIClient';
import type {GraphQLVariable} from '../GitHubAPIClient';

const EXPENSIFY_ORG = 'Expensify';

type TeamMemberSearch = {
    login: string;
    alias: string;
    variable: GraphQLVariable;
};

type TeamSearch = {
    slug: string;
    alias: string;
    variable: GraphQLVariable;
};

type TeamMemberSearchResult = {
    nodes: Array<{login: string}>;
};

type TeamMembersResponse = {
    organization: Record<string, Record<string, TeamMemberSearchResult | null> | null> | null;
};

/**
 * Returns the candidate logins that belong to any of the teams, batching all searches into one request.
 */
async function getTeamMemberLogins(client: GitHubAPIClient, teamSlugs: string[], candidateLogins: string[]): Promise<Set<string>> {
    const teamMemberLogins = new Set<string>();
    const uniqueTeamSlugs = new Set(teamSlugs);
    const uniqueCandidateLogins = new Set(candidateLogins);

    if (uniqueTeamSlugs.size === 0 || uniqueCandidateLogins.size === 0) {
        return teamMemberLogins;
    }

    const organizationVariable = createGraphQLVariable('organization', EXPENSIFY_ORG);
    const memberSearches: TeamMemberSearch[] = [...uniqueCandidateLogins].map((login, index) => {
        const alias = `member${index}`;
        return {
            login,
            alias,
            variable: createGraphQLVariable(alias, login),
        };
    });
    const teamSearches: TeamSearch[] = [...uniqueTeamSlugs].map((slug, index) => {
        const alias = `team${index}`;
        return {
            slug,
            alias,
            variable: createGraphQLVariable(`teamSlug${index}`, slug),
        };
    });

    const queryVariables: GraphQLVariable[] = [organizationVariable, ...memberSearches.map(({variable}) => variable), ...teamSearches.map(({variable}) => variable)];
    const teamQueries = teamSearches.map((teamSearch) => {
        const memberQueries = memberSearches.map(
            (memberSearch) => `
                ${memberSearch.alias}: members(first: 1, query: ${memberSearch.variable.reference}) {
                    nodes {
                        login
                    }
                }
            `,
        );

        return `
            ${teamSearch.alias}: team(slug: ${teamSearch.variable.reference}) {
                ${memberQueries.join('\n')}
            }
        `;
    });

    const variables: Record<string, string> = {};
    const variableDeclarations: Array<GraphQLVariable['declaration']> = [];
    for (const variable of queryVariables) {
        variables[variable.name] = variable.value;
        variableDeclarations.push(variable.declaration);
    }

    const query = `
        query TeamMembers(${variableDeclarations.join(', ')}) {
            organization(login: ${organizationVariable.reference}) {
                ${teamQueries.join('\n')}
            }
        }
    `;

    const response = await client.graphql<TeamMembersResponse>(query, variables);
    const organization = response.organization;
    if (!organization) {
        throw new Error(`${EXPENSIFY_ORG} organization could not be found.`);
    }

    for (const teamSearch of teamSearches) {
        const team = organization[teamSearch.alias];
        if (!team) {
            throw new Error(`${EXPENSIFY_ORG}/${teamSearch.slug} team could not be found.`);
        }

        for (const memberSearch of memberSearches) {
            const members = team[memberSearch.alias];
            if (!members) {
                throw new Error(`Missing team membership search result for ${memberSearch.login} in ${teamSearch.slug}.`);
            }

            // GitHub's query can be fuzzy, so only an exact login match proves membership.
            if (members.nodes.some((member) => member.login === memberSearch.login)) {
                teamMemberLogins.add(memberSearch.login);
            }
        }
    }

    return teamMemberLogins;
}

export default getTeamMemberLogins;
