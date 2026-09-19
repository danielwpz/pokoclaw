import {
  type ToolFailure,
  toolRecoverableError,
  toolRetryableError,
} from "@/src/tools/core/errors.js";
import { WebProviderChainError } from "@/src/tools/web/provider-chain.js";

export function webProviderChainToToolFailure(
  toolName: "web_search" | "web_fetch",
  error: unknown,
): ToolFailure {
  if (!(error instanceof WebProviderChainError)) {
    return toolRecoverableError(`${toolName} failed due to an internal provider-routing error.`, {
      code: `${toolName}_failed`,
      reason: "system_unavailable",
      retryable: false,
      recommendedAction: "report",
    });
  }

  const failures = error.failures.map(({ failure }) => failure);
  if (failures.some((failure) => failure.code === "aborted")) {
    return toolRecoverableError(`${toolName} was cancelled.`, {
      code: `${toolName}_cancelled`,
      reason: "cancelled",
      retryable: false,
      recommendedAction: "none",
    });
  }

  if (failures.some((failure) => failure.retryable)) {
    return toolRetryableError(`${toolName} is temporarily unavailable. Retry later.`, {
      code: `${toolName}_failed`,
      reason: "temporary_unavailable",
      retryable: true,
      recommendedAction: "retry",
    });
  }

  if (
    failures.some((failure) => failure.code === "invalid_request" || failure.code === "not_found")
  ) {
    const guidance =
      toolName === "web_fetch"
        ? "Try a different public HTTP(S) URL."
        : "Revise the search query before trying again.";
    return toolRecoverableError(`${toolName} could not process this request. ${guidance}`, {
      code: `${toolName}_failed`,
      reason: "request_rejected",
      retryable: false,
      recommendedAction: "change_request",
    });
  }

  return toolRecoverableError(
    `${toolName} is unavailable because its system services require operator attention. Do not retry unchanged.`,
    {
      code: `${toolName}_failed`,
      reason: "system_unavailable",
      retryable: false,
      recommendedAction: "report",
    },
  );
}
