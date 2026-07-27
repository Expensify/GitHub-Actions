import getEmployeeLogins from './getEmployeeLogins';
import getLatestApprovers from './getLatestApprovers';
import getRequiredApprovingReviewCount from './getRequiredApprovingReviewCount';
import isBotUser from './isBotUser';
import listPullRequestCommits from './listPullRequestCommits';

// Defined here (rather than its own file, like its siblings) so it calls GitHubUtils.getEmployeeLogins()
// through this exported object instead of importing getEmployeeLogins directly — tests mock the former.
async function isExpensifyEmployee(login: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- GitHubUtils isn't read until this function is called, well after module init
    const employeeLogins = await GitHubUtils.getEmployeeLogins();
    return employeeLogins.has(login);
}

const GitHubUtils = {
    getEmployeeLogins,
    getLatestApprovers,
    getRequiredApprovingReviewCount,
    isBotUser,
    isExpensifyEmployee,
    listPullRequestCommits,
};

export default GitHubUtils;
