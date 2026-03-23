import path from "node:path";
import type { PermissionCheckResult } from "@/src/security/permissions.js";
import { normalizeFilesystemTargetPath } from "@/src/security/permissions.js";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import { toolRecoverableError } from "@/src/tools/errors.js";
import type { ToolExecutionContext } from "@/src/tools/types.js";

export function resolveToolOwnerAgentId(context: ToolExecutionContext): string {
  if (context.ownerAgentId == null || context.ownerAgentId.trim().length === 0) {
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
}

export function createFilesystemAccessController(
  context: ToolExecutionContext,
): FilesystemAccessController {
  const ownerAgentId = resolveToolOwnerAgentId(context);
  const cwd = resolveToolCwd(context);
  const security = new SecurityService(context.storage);

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
    const decision = check(input);
    if (decision.access.result === "deny") {
      const action = input.kind === "fs.read" ? "read" : "write";
      const prefix =
        decision.access.reason === "hard_deny"
          ? `The ${action} request is blocked by system policy`
          : `The ${action} request is not currently granted`;
      throw toolRecoverableError(`${prefix}: ${decision.normalizedPath}`, {
        code: "filesystem_access_denied",
        permissionKind: input.kind,
        accessReason: decision.access.reason,
        path: decision.normalizedPath,
        summary: decision.access.summary,
      });
    }

    return decision.normalizedPath;
  };

  return {
    cwd,
    check,
    require,
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

export function formatDisplayPath(targetPath: string, _cwd: string): string {
  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  const normalizedRelativePath = path.normalize(targetPath);
  return normalizedRelativePath.length === 0 ? "." : normalizedRelativePath;
}
