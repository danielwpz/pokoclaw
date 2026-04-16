export const APPROVAL_DENIED_USER_INTERVENTION_CODE = "approval_denied_user_intervention" as const;

export const TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE =
  "tool_batch_aborted_user_intervention" as const;

export function isUserInterruptionSyntheticToolResultCode(
  code: string | null | undefined,
): boolean {
  return (
    code === APPROVAL_DENIED_USER_INTERVENTION_CODE ||
    code === TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE
  );
}
