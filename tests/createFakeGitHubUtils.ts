import type {GitHubUtils} from '../scripts/libs/GitHubUtils';
import isBotUser from '../scripts/libs/GitHubUtils/isBotUser';

function createFakeGitHubUtils(overrides: Partial<GitHubUtils> = {}): GitHubUtils {
    return {
        getEmployeeLogins: async () => new Set(),
        getLatestApprovers: async () => [],
        getRequiredApprovingReviewCount: async () => 1,
        isBotUser,
        isExpensifyEmployee: async () => false,
        listPullRequestCommits: async () => [],
        ...overrides,
    };
}

export default createFakeGitHubUtils;
