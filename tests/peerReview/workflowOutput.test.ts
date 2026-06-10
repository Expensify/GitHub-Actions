import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeWorkflowCommandProperty,
  escapeWorkflowCommandValue,
  formatUsers,
  getFailureTitle,
} from "../../libs/peerReview/workflowOutput";

describe("workflowOutput helpers", () => {
  it("formats empty user lists", () => {
    assert.equal(formatUsers([]), "(none)");
  });

  it("escapes workflow command values", () => {
    assert.equal(escapeWorkflowCommandValue("a\nb%"), "a%0Ab%25");
  });

  it("escapes workflow command properties", () => {
    assert.equal(
      escapeWorkflowCommandProperty("title:one,two"),
      "title%3Aone%2Ctwo",
    );
  });

  it("maps failure titles for known messages", () => {
    assert.equal(
      getFailureTitle(
        "Expensify/Auth#1 does not have enough independent Expensify employee approvals.",
      ),
      "Missing independent peer review",
    );
    assert.equal(
      getFailureTitle(
        "Unable to read branch protection rules for Expensify/Auth@main.",
      ),
      "Branch protection lookup failed",
    );
  });
});
