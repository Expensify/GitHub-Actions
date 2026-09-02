import type GitHubAPIClient from '../GitHubAPIClient';
import getLatestApprovers from './getLatestApprovers';
import getPullRequestCommitCount from './getPullRequestCommitCount';
import getRequiredApprovingReviewCount from './getRequiredApprovingReviewCount';
import getTeamMemberLogins, {getEmployeeLogins, isExpensifyEmployee} from './getTeamMemberLogins';
import isBotUser from './isBotUser';
import type {ActorType} from './isBotUser';
import listPullRequestCommits from './listPullRequestCommits';

export type {ActorType};

/**
 * Binds the GitHubUtils helper functions to a single GitHubAPIClient instance.
 */
function createGitHubUtils(client: GitHubAPIClient) {
    return {
        getEmployeeLogins: () => getEmployeeLogins(client),
        getLatestApprovers: (args: {owner: string; repo: string; number: number}) => getLatestApprovers(client, args),
        getPullRequestCommitCount: (args: {owner: string; repo: string; number: number}) => getPullRequestCommitCount(client, args),
        getRequiredApprovingReviewCount: (args: {owner: string; repo: string; baseRef: string}) => getRequiredApprovingReviewCount(client, args),
        isBotUser,
        isExpensifyEmployee: (login: string) => isExpensifyEmployee(client, login),
        getTeamMemberLogins: (teamSlug: string) => getTeamMemberLogins(client, teamSlug),
        listPullRequestCommits: (args: {owner: string; repo: string; number: number}) => listPullRequestCommits(client, args),
    };
}

type GitHubUtils = ReturnType<typeof createGitHubUtils>;

export type {GitHubUtils};
export default createGitHubUtils;
