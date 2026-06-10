import { getCommitAuthors } from "../libs/peerReview/coAuthors";
import { getPullRequestContext } from "../libs/peerReview/eventContext";
import {
  getEmployeeLogins,
  getLatestApprovers,
  getRequiredApprovingReviewCount,
  listPullRequestCommits,
} from "../libs/peerReview/githubApi";
import { evaluatePeerReview } from "../libs/peerReview/policy";
import { emitFailure } from "../libs/peerReview/workflowOutput";

export async function main(): Promise<void> {
  const context = getPullRequestContext();
  const { owner, repo, number, baseRef } = context;

  const [requiredApprovingReviewCount, approvers, commits] = await Promise.all([
    getRequiredApprovingReviewCount(context),
    getLatestApprovers(context),
    listPullRequestCommits(context),
  ]);

  const { authors, unresolvedExpensifyCoAuthors } = getCommitAuthors(commits);

  const employeeLogins =
    approvers.length > 0 && requiredApprovingReviewCount > 0
      ? await getEmployeeLogins()
      : new Set<string>();

  const result = evaluatePeerReview({
    owner,
    repo,
    number,
    baseRef,
    requiredApprovingReviewCount,
    approvers,
    authors,
    unresolvedExpensifyCoAuthors,
    employeeLogins,
  });

  if (result.status === "skip" || result.status === "pass") {
    console.log(result.reason);
    return;
  }

  throw result.error;
}

if (import.meta.main) {
  main().catch(emitFailure);
}
