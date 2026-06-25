import type { RestEndpointMethodTypes } from "@octokit/rest";
import CONST from "../github/CONST";
import WorkflowOutput from "./workflowOutput";

type Commit =
  RestEndpointMethodTypes["pulls"]["listCommits"]["response"]["data"][number];

function coAuthorEmails(message: string): string[] {
  return [...message.matchAll(/^Co-authored-by:\s+.+<(.+)>$/gim)].map((match) =>
    match[1].trim(),
  );
}

function resolveCoAuthorLogin(email: string): string | null {
  const normalizedEmail = email.trim();
  return (
    normalizedEmail.match(
      /^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i,
    )?.[1] ?? null
  );
}

function isExpensifyEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@expensify.com");
}

function getCanonicalAuthorLogin(commit: Commit): string {
  const authorLogin = commit.author?.login ?? "";
  if (authorLogin) {
    return authorLogin;
  }

  // If the author's profile is private, author.login may be missing. Fall back to the commit author name.
  return commit.commit.author?.name?.trim() ?? "";
}

function getCommitAuthors(commits: Commit[]): {
  authors: string[];
  unresolvedExpensifyCoAuthors: string[];
} {
  const authors = new Set<string>();
  const unresolvedExpensifyCoAuthors = new Set<string>();

  for (const commit of commits) {
    const canonicalAuthor = getCanonicalAuthorLogin(commit);
    if (canonicalAuthor) {
      authors.add(canonicalAuthor);
    }

    // Co-authorship between two humans from making and accepting a suggestion does not violate peer review.
    // Only parse co-authors when the canonical commit author is missing or is a bot.
    if (canonicalAuthor && !CONST.BOT_USERS.has(canonicalAuthor)) {
      continue;
    }

    for (const email of coAuthorEmails(commit.commit.message)) {
      const login = resolveCoAuthorLogin(email);
      if (login) {
        authors.add(login);
      } else if (isExpensifyEmail(email)) {
        // Open-source action cannot resolve @expensify.com emails via internal whitelist; fail-hard instead.
        unresolvedExpensifyCoAuthors.add(email.trim());
      }
    }
  }

  return {
    authors: WorkflowOutput.unique([...authors]),
    unresolvedExpensifyCoAuthors: WorkflowOutput.unique([
      ...unresolvedExpensifyCoAuthors,
    ]),
  };
}

export type { Commit };

export default {
  coAuthorEmails,
  getCommitAuthors,
  resolveCoAuthorLogin,
};
