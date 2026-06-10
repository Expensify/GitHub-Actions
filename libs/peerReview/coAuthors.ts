import type { RestEndpointMethodTypes } from "@octokit/rest";
import { BOT_USERS } from "../github/CONST";
import { unique } from "./workflowOutput";

export type Commit =
  RestEndpointMethodTypes["pulls"]["listCommits"]["response"]["data"][number];

export function coAuthorEmails(message: string): string[] {
  return [...message.matchAll(/^Co-authored-by:\s+.+<(.+)>$/gim)].map((match) =>
    match[1].trim(),
  );
}

export function resolveCoAuthorLogin(email: string): string | null {
  return (
    email.match(/^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i)?.[1] ?? null
  );
}

export function getCommitAuthors(commits: Commit[]): {
  authors: string[];
  unresolvedExpensifyCoAuthors: string[];
} {
  const authors = new Set<string>();
  const unresolvedExpensifyCoAuthors = new Set<string>();

  for (const commit of commits) {
    const canonicalAuthor = commit.author?.login ?? "";
    if (canonicalAuthor) {
      authors.add(canonicalAuthor);
    }

    if (canonicalAuthor && !BOT_USERS.has(canonicalAuthor)) {
      continue;
    }

    for (const email of coAuthorEmails(commit.commit.message)) {
      const login = resolveCoAuthorLogin(email);
      if (login) {
        authors.add(login);
      } else if (email.trim().toLowerCase().endsWith("@expensify.com")) {
        unresolvedExpensifyCoAuthors.add(email.trim());
      }
    }
  }

  return {
    authors: unique([...authors]),
    unresolvedExpensifyCoAuthors: unique([...unresolvedExpensifyCoAuthors]),
  };
}
