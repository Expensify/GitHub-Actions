import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { RequestError } from "@octokit/request-error";
import GithubUtils from "../../libs/github/GithubUtils";
import { getRequiredApprovingReviewCount } from "../../libs/peerReview/githubApi";

const context = {
  owner: "Expensify",
  repo: "Auth",
  number: 1,
  baseRef: "main",
};

describe("getRequiredApprovingReviewCount", () => {
  afterEach(() => {
    GithubUtils.internalOctokit = undefined;
    GithubUtils.graphqlClient = undefined;
  });

  it("returns 0 when branch protection rule is missing", async () => {
    GithubUtils.graphqlClient = (async () => ({
      repository: {
        ref: {
          branchProtectionRule: null,
        },
      },
    })) as NonNullable<typeof GithubUtils.graphqlClient>;

    const count = await getRequiredApprovingReviewCount({
      ...context,
      baseRef: "staging",
    });
    assert.equal(count, 0);
  });

  it("throws on permission errors", async () => {
    GithubUtils.graphqlClient = (async () => {
      throw new RequestError("Resource not accessible by integration", 403, {
        request: {
          method: "POST",
          url: "https://api.github.com/graphql",
          headers: {},
        },
      });
    }) as typeof GithubUtils.graphqlClient;

    await assert.rejects(
      () => getRequiredApprovingReviewCount(context),
      /Unable to read branch protection rules/,
    );
  });
});
