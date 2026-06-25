import CoAuthors from "./libs/peerReview/coAuthors";
import EventContext from "./libs/peerReview/eventContext";
import PeerReviewGitHubApi from "./libs/peerReview/githubApi";
import Policy from "./libs/peerReview/policy";
import WorkflowOutput from "./libs/peerReview/workflowOutput";

async function main(): Promise<void> {
  const context = EventContext.getPullRequestContext();
  const { owner, repo, number, baseRef } = context;

  const [requiredApprovingReviewCount, approvers, commits] = await Promise.all([
    PeerReviewGitHubApi.getRequiredApprovingReviewCount(context),
    PeerReviewGitHubApi.getLatestApprovers(context),
    PeerReviewGitHubApi.listPullRequestCommits(context),
  ]);

  const { authors, unresolvedExpensifyCoAuthors } =
    CoAuthors.getCommitAuthors(commits);

  const employeeLogins =
    approvers.length > 0 && requiredApprovingReviewCount > 0
      ? await PeerReviewGitHubApi.getEmployeeLogins()
      : new Set<string>();

  const result = Policy.evaluatePeerReview({
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

export default {
  main,
};

if (import.meta.main) {
  main().catch(WorkflowOutput.emitFailure);
}
