import type GitHubAPIClient from '../GitHubAPIClient';

const EXPENSIFY_ORG = 'Expensify';

type TeamMembersResponse = {
    organization: Record<string, Record<string, {nodes: Array<{login: string}>} | null> | null> | null;
};

/**
 * Returns the candidate logins that belong to any of the teams, using a single GraphQL request.
 *
 * For teams ['expensify-expensify', 'margelo'] and candidates ['rafecolton', 'chrispader'], the query is:
 *
 *   {
 *     organization(login: "Expensify") {
 *       team0: team(slug: "expensify-expensify") {
 *         member0: members(first: 1, query: "rafecolton") { nodes { login } }
 *         member1: members(first: 1, query: "chrispader") { nodes { login } }
 *       }
 *       team1: team(slug: "margelo") {
 *         member0: members(first: 1, query: "rafecolton") { nodes { login } }
 *         member1: members(first: 1, query: "chrispader") { nodes { login } }
 *       }
 *     }
 *   }
 *
 * Aliases are index-based because logins and slugs can contain characters that aren't valid in GraphQL aliases (e.g. `-`).
 */
async function getTeamMemberLogins(client: GitHubAPIClient, teamSlugs: string[], candidateLogins: string[]): Promise<Set<string>> {
    const uniqueTeamSlugs = [...new Set(teamSlugs)];
    const uniqueCandidateLogins = [...new Set(candidateLogins)];
    const teamMemberLogins = new Set<string>();
    if (uniqueTeamSlugs.length === 0 || uniqueCandidateLogins.length === 0) {
        return teamMemberLogins;
    }

    // JSON.stringify produces a properly quoted and escaped GraphQL string literal.
    const memberQueries = uniqueCandidateLogins.map((login, i) => `member${i}: members(first: 1, query: ${JSON.stringify(login)}) { nodes { login } }`).join('\n');
    const teamQueries = uniqueTeamSlugs.map((slug, i) => `team${i}: team(slug: ${JSON.stringify(slug)}) {\n${memberQueries}\n}`).join('\n');
    const response = await client.graphql<TeamMembersResponse>(`{\norganization(login: "${EXPENSIFY_ORG}") {\n${teamQueries}\n}\n}`);

    const organization = response.organization;
    if (!organization) {
        throw new Error(`${EXPENSIFY_ORG} organization could not be found.`);
    }

    for (const [teamIndex, slug] of uniqueTeamSlugs.entries()) {
        const team = organization[`team${teamIndex}`];
        if (!team) {
            throw new Error(`${EXPENSIFY_ORG}/${slug} team could not be found.`);
        }

        for (const [memberIndex, login] of uniqueCandidateLogins.entries()) {
            const members = team[`member${memberIndex}`];
            if (!members) {
                throw new Error(`Missing team membership search result for ${login} in ${slug}.`);
            }

            // The members search is fuzzy and case-insensitive, so only an exact login match proves membership.
            if (members.nodes.some((member) => member.login === login)) {
                teamMemberLogins.add(login);
            }
        }
    }

    return teamMemberLogins;
}

export default getTeamMemberLogins;
