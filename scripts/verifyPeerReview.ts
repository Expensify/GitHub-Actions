import { BOT_USERS } from "../libs/github/CONST";
import { getCommitAuthors } from "../libs/peerReview/coAuthors";
import { getPullRequestContext } from "../libs/peerReview/eventContext";
import {
  getEmployeeLogins,
  getLatestApprovers,
  getRequiredApprovingReviewCount,
  listPullRequestCommits,
} from "../libs/peerReview/githubApi";
import { getIndependentEmployeeApprovers } from "../libs/peerReview/policy";
import { emitFailure, formatUsers } from "../libs/peerReview/workflowOutput";

export async function main(): Promise<void> {
  const context = getPullRequestContext();
  const { owner, repo, number, baseRef } = context;

  const [requiredApprovingReviewCount, approvers, commits] = await Promise.all([
    getRequiredApprovingReviewCount(context),
    getLatestApprovers(context),
    listPullRequestCommits(context),
  ]);

  if (requiredApprovingReviewCount === 0) {
    console.log(
      `${owner}/${repo}#${number} targets ${baseRef}, which does not require approving reviews.`,
    );
    return;
  }

  if (approvers.length === 0) {
    console.log(
      `${owner}/${repo}#${number} has no approving reviews from writers; regular branch protection will block merge until an approval exists.`,
    );
    return;
  }

  const { authors, unresolvedExpensifyCoAuthors } = getCommitAuthors(commits);

  if (unresolvedExpensifyCoAuthors.length > 0) {
    throw new Error(
      `Unable to resolve Expensify co-author emails to GitHub users: ${formatUsers(unresolvedExpensifyCoAuthors)}`,
    );
  }

  if (authors.every((author) => BOT_USERS.has(author))) {
    throw new Error(
      `Unable to verify independent peer review because ${owner}/${repo}#${number} has no human commit authors or co-authors.`,
    );
  }

  const employeeLogins = await getEmployeeLogins();
  const independentEmployeeApprovers = getIndependentEmployeeApprovers(
    approvers,
    authors,
    employeeLogins,
  );

  if (independentEmployeeApprovers.length < requiredApprovingReviewCount) {
    throw new Error(
      [
        `${owner}/${repo}#${number} does not have enough independent Expensify employee approvals.`,
        `Required independent approvals: ${requiredApprovingReviewCount}`,
        `Commit authors/co-authors: ${formatUsers(authors)}`,
        `Approvers: ${formatUsers(approvers)}`,
        `Independent employee approvers: ${formatUsers(independentEmployeeApprovers)}`,
      ].join("\n"),
    );
  }

  console.log(
    `${owner}/${repo}#${number} has ${independentEmployeeApprovers.length} independent Expensify employee approval(s).`,
  );
}

if (import.meta.main) {
  main().catch(emitFailure);
}
