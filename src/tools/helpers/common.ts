import path from "node:path";
import type { PermissionCheckResult } from "@/src/security/permissions.js";
import { normalizeFilesystemTargetPath } from "@/src/security/permissions.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { describePermissionScope, type PermissionScope } from "@/src/security/scope.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import type { ToolExecutionContext } from "@/src/tools/core/types.js";
import {
  buildPermissionDeniedDetails,
  compressPermissionScopesToEntries,
} from "@/src/tools/helpers/permission-block.js";

const logger = createSubsystemLogger("tools");

export function resolveToolOwnerAgentId(context: ToolExecutionContext): string {
  if (context.ownerAgentId == null || context.ownerAgentId.trim().length === 0) {
    logger.warn("tool call missing owner agent", {
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      toolCallId: context.toolCallId,
    });
    throw toolRecoverableError(
      "This tool call is missing its owner agent context, so the permission check cannot run.",
      { code: "missing_owner_agent" },
    );
  }

  return context.ownerAgentId;
}

export function resolveToolCwd(context: ToolExecutionContext): string {
  return context.cwd == null || context.cwd.trim().length === 0
    ? POKECLAW_WORKSPACE_DIR
    : context.cwd;
}

export function normalizeToolTargetPath(targetPath: string, cwd: string): string {
  return normalizeFilesystemTargetPath(targetPath, cwd);
}

export interface FilesystemAccessDecision {
  access: PermissionCheckResult;
  normalizedPath: string;
}

export interface FilesystemAccessController {
  cwd: string;
  check: (input: { kind: "fs.read" | "fs.write"; targetPath: string }) => FilesystemAccessDecision;
  require: (input: { kind: "fs.read" | "fs.write"; targetPath: string }) => string;
  authorize: (
    inputs: Array<{ kind: "fs.read" | "fs.write"; targetPath: string }>,
  ) => FilesystemAccessDecision[];
}

export function createFilesystemAccessController(
  context: ToolExecutionContext,
): FilesystemAccessController {
  const ownerAgentId = resolveToolOwnerAgentId(context);
  const cwd = resolveToolCwd(context);
  const security = new SecurityService(
    context.storage,
    buildSystemPolicy({ security: context.securityConfig }),
  );

  const check = (input: {
    kind: "fs.read" | "fs.write";
    targetPath: string;
  }): FilesystemAccessDecision => {
    const access = security.checkFilesystemAccess({
      ownerAgentId,
      kind: input.kind,
      targetPath: input.targetPath,
      cwd,
    });
    const normalizedPath = normalizeToolTargetPath(input.targetPath, cwd);

    return {
      access,
      normalizedPath,
    };
  };

  const require = (input: { kind: "fs.read" | "fs.write"; targetPath: string }): string => {
    return authorize([input])[0]?.normalizedPath ?? normalizeToolTargetPath(input.targetPath, cwd);
  };

  const authorize = (
    inputs: Array<{ kind: "fs.read" | "fs.write"; targetPath: string }>,
  ): FilesystemAccessDecision[] => {
    const decisions = inputs.map((item) => ({
      ...item,
      ...check(item),
    }));
    const hardDeny = decisions.find(
      (decision) => decision.access.result === "deny" && decision.access.reason === "hard_deny",
    );
    if (hardDeny != null) {
      const hardDenyScopes: PermissionScope[] = [
        {
          kind: hardDeny.kind,
          path: hardDeny.normalizedPath,
        },
      ];
      const entries = compressPermissionScopesToEntries(hardDenyScopes);
      logger.info("filesystem access blocked by policy", {
        sessionId: context.sessionId,
        ownerAgentId,
        toolCallId: context.toolCallId,
        kind: hardDeny.kind,
        path: hardDeny.normalizedPath,
      });
      throw toolRecoverableError(
        hardDeny.access.summary,
        buildPermissionDeniedDetails({
          requestable: false,
          summary: hardDeny.access.summary,
          entries,
          ...(context.toolCallId == null ? {} : { failedToolCallId: context.toolCallId }),
        }),
      );
    }

    const requestedScopes = collectMissingFilesystemScopes(decisions);
    if (requestedScopes.length > 0) {
      logger.info("filesystem approval required", {
        sessionId: context.sessionId,
        ownerAgentId,
        toolCallId: context.toolCallId,
        scopeCount: requestedScopes.length,
        scope: requestedScopes[0] == null ? undefined : describePermissionScope(requestedScopes[0]),
      });
      const entries = compressPermissionScopesToEntries(requestedScopes);
      throw toolRecoverableError(
        buildFilesystemApprovalReason(requestedScopes),
        buildPermissionDeniedDetails({
          requestable: true,
          summary: buildFilesystemApprovalReason(requestedScopes),
          entries,
          ...(context.toolCallId == null ? {} : { failedToolCallId: context.toolCallId }),
        }),
      );
    }

    return decisions.map(({ access, normalizedPath }) => ({
      access,
      normalizedPath,
    }));
  };

  return {
    cwd,
    check,
    require,
    authorize,
  };
}

export function requireFilesystemAccess(
  context: ToolExecutionContext,
  input: {
    kind: "fs.read" | "fs.write";
    targetPath: string;
  },
): string {
  return createFilesystemAccessController(context).require(input);
}

function collectMissingFilesystemScopes(
  decisions: Array<{
    kind: "fs.read" | "fs.write";
    access: PermissionCheckResult;
    normalizedPath: string;
  }>,
): PermissionScope[] {
  const scopes = new Map<string, PermissionScope>();
  for (const decision of decisions) {
    if (decision.access.result !== "deny" || decision.access.reason !== "not_granted") {
      continue;
    }

    const scope: PermissionScope = {
      kind: decision.kind,
      path: decision.normalizedPath,
    };
    scopes.set(`${scope.kind}:${scope.path}`, scope);
  }

  return [...scopes.values()];
}

function buildFilesystemApprovalReason(scopes: PermissionScope[]): string {
  const firstScope = scopes[0];
  if (scopes.length === 1 && firstScope != null) {
    return `${describePermissionScope(firstScope)} access is missing.`;
  }

  return `${scopes.map(describePermissionScope).join("; ")} access is missing.`;
}

export function formatDisplayPath(targetPath: string, _cwd: string): string {
  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  const normalizedRelativePath = path.normalize(targetPath);
  return normalizedRelativePath.length === 0 ? "." : normalizedRelativePath;
}
