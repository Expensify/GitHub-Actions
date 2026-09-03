import type {GitHubUtils} from '../scripts/libs/GitHubUtils';
import isBotUser from '../scripts/libs/GitHubUtils/isBotUser';

function createFakeGitHubUtils(overrides: Partial<GitHubUtils> = {}): GitHubUtils {
    return {
        getLatestApprovers: async () => [],
        getPullRequestCommitCount: async () => 0,
        getRequiredApprovingReviewCount: async () => 1,
        getTeamMemberLogins: async () => new Set(),
        isBotUser,
        listPullRequestCommits: async () => [],
        ...overrides,
    };
}

export default createFakeGitHubUtils;
