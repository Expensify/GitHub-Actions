import assert from "node:assert/strict";
import { describe, it } from "node:test";
import GitCommitUtils, {
  type GitHubPullRequestCommit,
} from "../scripts/libs/GitCommitUtils";

function makeCommit(
  authorLogin: string | undefined,
  authorName: string | undefined,
  message: string,
): GitHubPullRequestCommit {
  return {
    author: authorLogin ? { login: authorLogin } : null,
    commit: {
      message,
      author: authorName ? { name: authorName } : {},
    },
  };
}

describe("resolveNoreplyEmailToLogin", () => {
  it("parses standard noreply addresses", () => {
    assert.equal(
      GitCommitUtils.resolveNoreplyEmailToLogin(
        "AndrewGable@users.noreply.github.com",
      ),
      "AndrewGable",
    );
  });

  it("parses numeric noreply prefixes", () => {
    assert.equal(
      GitCommitUtils.resolveNoreplyEmailToLogin(
        "2838819+AndrewGable@users.noreply.github.com",
      ),
      "AndrewGable",
    );
  });
});

describe("coAuthorEmails", () => {
  it("extracts multiple co-author emails", () => {
    const message = [
      "Some change",
      "",
      "Co-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>",
      "Co-authored-by: Monil Bhavsar <MonilBhavsar@users.noreply.github.com>",
    ].join("\n");

    assert.deepEqual(GitCommitUtils.coAuthorEmails(message), [
      "AndrewGable@users.noreply.github.com",
      "MonilBhavsar@users.noreply.github.com",
    ]);
  });
});

describe("getCanonicalAuthorLogin", () => {
  it("falls back to commit author name when github login is missing", () => {
    assert.equal(
      GitCommitUtils.getCanonicalAuthorLogin(
        makeCommit(undefined, "AndrewGable", "Change"),
      ),
      "AndrewGable",
    );
  });
});
