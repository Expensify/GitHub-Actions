import { appendFileSync } from "node:fs";

export function formatUsers(users: string[]): string {
  return users.length > 0 ? users.join(", ") : "(none)";
}

export function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function escapeWorkflowCommandValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeWorkflowCommandProperty(value: string): string {
  return escapeWorkflowCommandValue(value)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

export function getFailureTitle(message: string): string {
  if (
    message.includes(
      "does not have enough independent Expensify employee approvals",
    )
  ) {
    return "Missing independent peer review";
  }
  if (message.includes("Unable to resolve Expensify co-author emails")) {
    return "Unresolved Expensify co-author";
  }
  if (message.includes("has no human commit authors or co-authors")) {
    return "No human commit author";
  }
  return "Peer review verification failed";
}

export function writeStepSummary(title: string, message: string): void {
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!stepSummaryPath) {
    return;
  }
  appendFileSync(
    stepSummaryPath,
    `## ${title}\n\n${message.replace(/\n/g, "\n\n")}\n`,
  );
}

export function emitFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const title = getFailureTitle(message);
  writeStepSummary(title, message);
  console.error(
    `::error title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandValue(message)}`,
  );
  process.exit(1);
}
