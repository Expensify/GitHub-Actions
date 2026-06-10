export type PullRequestContext = {
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
};

export type PeerReviewInput = {
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
  requiredApprovingReviewCount: number;
  approvers: string[];
  authors: string[];
  unresolvedExpensifyCoAuthors: string[];
  employeeLogins: Set<string>;
};

export type PeerReviewResult =
  | { status: "pass"; reason: string }
  | { status: "skip"; reason: string }
  | { status: "fail"; error: Error };
