import assert from "node:assert/strict";
import { describe, it } from "node:test";
import CoAuthors, { type Commit } from "../../libs/peerReview/coAuthors";

function makeCommit(
  authorLogin: string | undefined,
  authorName: string | undefined,
  message: string,
): Commit {
  return {
    author: authorLogin ? { login: authorLogin } : null,
    commit: {
      message,
      author: authorName ? { name: authorName } : {},
    },
  } as Commit;
}

describe("resolveCoAuthorLogin", () => {
  it("parses standard noreply addresses", () => {
    assert.equal(
      CoAuthors.resolveCoAuthorLogin("AndrewGable@users.noreply.github.com"),
      "AndrewGable",
    );
  });

  it("parses numeric noreply prefixes", () => {
    assert.equal(
      CoAuthors.resolveCoAuthorLogin(
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

    assert.deepEqual(CoAuthors.coAuthorEmails(message), [
      "AndrewGable@users.noreply.github.com",
      "MonilBhavsar@users.noreply.github.com",
    ]);
  });
});

describe("getCommitAuthors", () => {
  it("counts co-authors for bot-authored commits", () => {
    const result = CoAuthors.getCommitAuthors([
      makeCommit(
        "MelvinBot",
        undefined,
        "Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>",
      ),
    ]);

    assert.deepEqual(result.authors, ["AndrewGable", "MelvinBot"]);
    assert.deepEqual(result.unresolvedExpensifyCoAuthors, []);
  });

  it("ignores co-authors when canonical author is human", () => {
    const result = CoAuthors.getCommitAuthors([
      makeCommit(
        "rafecolton",
        undefined,
        "Change\n\nCo-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>",
      ),
    ]);

    assert.deepEqual(result.authors, ["rafecolton"]);
  });

  it("falls back to commit author name when github login is missing", () => {
    const result = CoAuthors.getCommitAuthors([
      makeCommit(undefined, "AndrewGable", "Change"),
    ]);

    assert.deepEqual(result.authors, ["AndrewGable"]);
  });

  it("normalizes expensify email casing and whitespace for unresolved detection", () => {
    const result = CoAuthors.getCommitAuthors([
      makeCommit(
        "MelvinBot",
        undefined,
        "Change\n\nCo-authored-by: Andrew Gable <  Andrew@Expensify.com  >",
      ),
    ]);

    assert.deepEqual(result.unresolvedExpensifyCoAuthors, [
      "Andrew@Expensify.com",
    ]);
  });

  it("collects unresolved expensify co-author emails", () => {
    const result = CoAuthors.getCommitAuthors([
      makeCommit(
        "MelvinBot",
        undefined,
        "Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>",
      ),
    ]);

    assert.deepEqual(result.unresolvedExpensifyCoAuthors, [
      "andrew@expensify.com",
    ]);
  });
});
