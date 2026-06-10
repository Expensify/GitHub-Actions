import { readFileSync } from "node:fs";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { PullRequestContext } from "./types";

export function getPullRequestContext(): PullRequestContext {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8")) as PullRequestEvent;
  return {
    owner: event.repository.owner.login,
    repo: event.repository.name,
    number: event.pull_request.number,
    baseRef: event.pull_request.base.ref,
  };
}
