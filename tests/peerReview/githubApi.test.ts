import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { RequestError } from "@octokit/request-error";
import GitHubAPI from "../../libs/github/GitHubAPI";
import PeerReviewGitHubApi from "../../libs/peerReview/githubApi";

const context = {
  owner: "Expensify",
  repo: "Auth",
  number: 1,
  baseRef: "main",
};

describe("getRequiredApprovingReviewCount", () => {
  afterEach(() => {
    GitHubAPI.internalOctokit = undefined;
    GitHubAPI.graphqlClient = undefined;
  });

  it("returns 0 when branch protection rule is missing", async () => {
    GitHubAPI.graphqlClient = (async () => ({
      repository: {
        ref: {
          branchProtectionRule: null,
        },
      },
    })) as NonNullable<typeof GitHubAPI.graphqlClient>;

    const count = await PeerReviewGitHubApi.getRequiredApprovingReviewCount({
      ...context,
      baseRef: "staging",
    });
    assert.equal(count, 0);
  });

  it("throws on permission errors", async () => {
    GitHubAPI.graphqlClient = (async () => {
      throw new RequestError("Resource not accessible by integration", 403, {
        request: {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {},
        },
      });
    }) as typeof GitHubAPI.graphqlClient;

    await assert.rejects(
      () => PeerReviewGitHubApi.getRequiredApprovingReviewCount(context),
      /Unable to read branch protection rules/,
    );
  });
});
