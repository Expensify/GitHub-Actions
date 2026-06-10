import { BOT_USERS } from "../github/CONST";
import { formatUsers } from "./workflowOutput";
import type { PeerReviewInput, PeerReviewResult } from "./types";

export const DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT = 1;

export function getIndependentEmployeeApprovers(
  approvers: string[],
  authors: string[],
  employeeLogins: Set<string>,
): string[] {
  const authorSet = new Set(authors);
  return approvers.filter(
    (approver) => !authorSet.has(approver) && employeeLogins.has(approver),
  );
}

export function evaluatePeerReview(input: PeerReviewInput): PeerReviewResult {
  const {
    owner,
    repo,
    number,
    baseRef,
    requiredApprovingReviewCount,
    approvers,
    authors,
    unresolvedExpensifyCoAuthors,
    employeeLogins,
  } = input;

  if (requiredApprovingReviewCount === 0) {
    return {
      status: "skip",
      reason: `${owner}/${repo}#${number} targets ${baseRef}, which does not require approving reviews.`,
    };
  }

  if (approvers.length === 0) {
    return {
      status: "skip",
      reason: `${owner}/${repo}#${number} has no approving reviews from writers; regular branch protection will block merge until an approval exists.`,
    };
  }

  if (unresolvedExpensifyCoAuthors.length > 0) {
    return {
      status: "fail",
      error: new Error(
        `Unable to resolve Expensify co-author emails to GitHub users: ${formatUsers(unresolvedExpensifyCoAuthors)}`,
      ),
    };
  }

  if (authors.every((author) => BOT_USERS.has(author))) {
    return {
      status: "fail",
      error: new Error(
        `Unable to verify independent peer review because ${owner}/${repo}#${number} has no human commit authors or co-authors.`,
      ),
    };
  }

  const independentEmployeeApprovers = getIndependentEmployeeApprovers(
    approvers,
    authors,
    employeeLogins,
  );
  if (independentEmployeeApprovers.length < requiredApprovingReviewCount) {
    return {
      status: "fail",
      error: new Error(
        [
          `${owner}/${repo}#${number} does not have enough independent Expensify employee approvals.`,
          `Required independent approvals: ${requiredApprovingReviewCount}`,
          `Commit authors/co-authors: ${formatUsers(authors)}`,
          `Approvers: ${formatUsers(approvers)}`,
          `Independent employee approvers: ${formatUsers(independentEmployeeApprovers)}`,
        ].join("\n"),
      ),
    };
  }

  return {
    status: "pass",
    reason: `${owner}/${repo}#${number} has ${independentEmployeeApprovers.length} independent Expensify employee approval(s).`,
  };
}
