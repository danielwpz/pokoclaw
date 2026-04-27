import type { EffectiveApprovalMode } from "@/src/runtime/runtime-modes.js";
import type { PermissionRequest, PermissionScope } from "@/src/security/scope.js";
import type { ToolExecutionApprovalState } from "@/src/tools/core/types.js";

export function buildRuntimeModeToolExecutionState(
  mode: EffectiveApprovalMode | undefined,
): ToolExecutionApprovalState | undefined {
  if (mode?.skipHumanApproval !== true || mode.source === "normal") {
    return undefined;
  }

  return {
    runtimeModeAutoApproval: {
      source: mode.source,
    },
  };
}

export function buildApprovedToolExecutionState(input: {
  baseState?: ToolExecutionApprovalState;
  request: PermissionRequest;
  approvalId: number;
  skippedHumanApproval: boolean;
}): ToolExecutionApprovalState | undefined {
  if (!input.skippedHumanApproval) {
    return input.baseState;
  }

  const nextState: ToolExecutionApprovalState = {
    ...(input.baseState ?? {}),
  };
  const ephemeralScopes = input.request.scopes.filter((scope) => scope.kind !== "bash.full_access");
  if (ephemeralScopes.length > 0) {
    nextState.ephemeralPermissionScopes = dedupePermissionScopes([
      ...(input.baseState?.ephemeralPermissionScopes ?? []),
      ...ephemeralScopes,
    ]);
  }

  if (input.request.scopes.some((scope) => scope.kind === "bash.full_access")) {
    nextState.bashFullAccess = {
      approved: true,
      mode: "one_shot",
      approvalId: input.approvalId,
    };
  }

  return nextState;
}

function dedupePermissionScopes(scopes: PermissionScope[]): PermissionScope[] {
  const unique = new Map<string, PermissionScope>();

  for (const scope of scopes) {
    if ("path" in scope) {
      unique.set(`${scope.kind}:${scope.path}`, scope);
      continue;
    }

    if ("prefix" in scope) {
      unique.set(`${scope.kind}:${scope.prefix.join("\u0000")}`, scope);
      continue;
    }

    unique.set(`${scope.kind}:${scope.database}`, scope);
  }

  return [...unique.values()];
}
