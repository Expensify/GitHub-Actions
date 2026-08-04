import type GitHubAPIClient from '../GitHubAPIClient';
import getEmployeeLogins, {isExpensifyEmployee} from './getEmployeeLogins';
import getLatestApprovers from './getLatestApprovers';
import getRequiredApprovingReviewCount from './getRequiredApprovingReviewCount';
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
        getRequiredApprovingReviewCount: (args: {owner: string; repo: string; baseRef: string}) => getRequiredApprovingReviewCount(client, args),
        isBotUser,
        isExpensifyEmployee: (login: string) => isExpensifyEmployee(client, login),
        listPullRequestCommits: (args: {owner: string; repo: string; number: number}) => listPullRequestCommits(client, args),
    };
}

type GitHubUtils = ReturnType<typeof createGitHubUtils>;

export type {GitHubUtils};
export default createGitHubUtils;
