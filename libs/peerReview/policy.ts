export const DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT = 1;

export function getIndependentEmployeeApprovers(
  approvers: string[],
  authors: string[],
  employeeLogins: Set<string>,
): string[] {
  const authorSet = new Set(authors);
  return approvers.filter(
    (approver) => !authorSet.has(approver) && employeeLogins.has(approver),
  );
}
