import { stat } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentToolResultPayload } from "@/src/agent/llm/messages.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";
import { toolApprovalRequired, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { resolveToolOwnerAgentId } from "@/src/tools/helpers/common.js";
import {
  expandPermissionEntriesToScopes,
  type PermissionAccess,
  type PermissionEntryScope,
  type PermissionRequestEntry,
} from "@/src/tools/helpers/permission-block.js";

const REQUEST_PERMISSIONS_ENTRY_SCHEMA = Type.Object(
  {
    resource: Type.Literal("filesystem", {
      description: "The only supported resource right now.",
    }),
    path: Type.String({
      description: "Absolute filesystem path. Do not use relative paths.",
    }),
    scope: Type.Union([Type.Literal("exact"), Type.Literal("subtree")], {
      description:
        "Use exact for a single file or path. Use subtree for a directory and everything under it.",
    }),
    access: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("read_write")], {
      description:
        "Prefer the smallest access that is still necessary. Use read_write only when both are needed.",
    }),
  },
  { additionalProperties: false },
);

export const REQUEST_PERMISSIONS_TOOL_SCHEMA = Type.Object(
  {
    entries: Type.Array(REQUEST_PERMISSIONS_ENTRY_SCHEMA, {
      minItems: 1,
      maxItems: 16,
      description:
        "One or more filesystem permission requests. Prefer the smallest legitimate scope.",
    }),
    justification: Type.String({
      minLength: 8,
      maxLength: 200,
      description:
        "A short human-readable reason for why this permission is necessary for the current user request.",
    }),
    retryToolCallId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional previous permission-denied tool_call_id from this same session. If approval succeeds, the runtime may retry it automatically.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type RequestPermissionsToolArgs = Static<typeof REQUEST_PERMISSIONS_TOOL_SCHEMA>;

export interface RequestPermissionsToolDetails {
  kind: "permission_request_result";
  status: "already_granted";
  entries: PermissionRequestEntry[];
  justification: string;
  retryToolCallId?: string;
}

const logger = createSubsystemLogger("tools/request-permissions");

export function createRequestPermissionsTool() {
  return defineTool({
    name: "request_permissions",
    description:
      "Request additional filesystem permissions when another tool was blocked. Only use this after a permission-blocked tool result, and only if the access is necessary and legitimate for the user's request. Prefer the smallest valid scope. For a single file use scope=exact. For a directory tree use scope=subtree.",
    inputSchema: REQUEST_PERMISSIONS_TOOL_SCHEMA,
    async execute(context, args) {
      const ownerAgentId = resolveToolOwnerAgentId(context);
      const security = new SecurityService(
        context.storage,
        buildSystemPolicy({ security: context.securityConfig }),
      );
      const entries = await validateRequestEntries({
        entries: args.entries,
        security,
        ownerAgentId,
        ...(context.cwd == null ? {} : { cwd: context.cwd }),
      });
      const latestPermissionFailure = args.retryToolCallId
        ? findLatestPermissionDeniedToolCall(
            context.storage,
            context.sessionId,
            args.retryToolCallId,
          )
        : null;

      if (args.retryToolCallId != null && latestPermissionFailure == null) {
        logger.warn("permission retry target not found", {
          sessionId: context.sessionId,
          ownerAgentId,
          toolCallId: context.toolCallId,
          retryToolCallId: args.retryToolCallId,
        });
        throw toolRecoverableError(
          `retryToolCallId ${args.retryToolCallId} does not match the latest permission-blocked tool call in this session.`,
          {
            code: "invalid_retry_tool_call_id",
            retryToolCallId: args.retryToolCallId,
          },
        );
      }

      const scopes = expandPermissionEntriesToScopes(entries);
      const allAlreadyGranted = scopes.every((scope) => {
        if (!("path" in scope) || context.ownerAgentId == null) {
          return false;
        }

        const access = security.checkFilesystemAccess({
          ownerAgentId: context.ownerAgentId,
          kind: scope.kind,
          targetPath: scope.path,
          ...(context.cwd == null ? {} : { cwd: context.cwd }),
        });
        return access.result === "allow";
      });

      if (allAlreadyGranted) {
        logger.info("permission request already granted", {
          sessionId: context.sessionId,
          ownerAgentId,
          toolCallId: context.toolCallId,
          entryCount: entries.length,
          path: entries[0]?.path,
          retryToolCallId: args.retryToolCallId,
        });
        return textToolResult("Requested permissions are already granted.", {
          kind: "permission_request_result",
          status: "already_granted",
          entries,
          justification: args.justification.trim(),
          ...(args.retryToolCallId == null ? {} : { retryToolCallId: args.retryToolCallId }),
        } satisfies RequestPermissionsToolDetails);
      }

      logger.info("permission request needs approval", {
        sessionId: context.sessionId,
        ownerAgentId,
        toolCallId: context.toolCallId,
        entryCount: entries.length,
        path: entries[0]?.path,
        retryToolCallId: args.retryToolCallId,
      });
      throw toolApprovalRequired({
        request: { scopes },
        reasonText: args.justification.trim(),
        ...(args.retryToolCallId == null ? {} : { retryToolCallId: args.retryToolCallId }),
      });
    },
  });
}

async function validateRequestEntries(input: {
  entries: RequestPermissionsToolArgs["entries"];
  security: SecurityService;
  ownerAgentId: string;
  cwd?: string;
}): Promise<PermissionRequestEntry[]> {
  const validated: PermissionRequestEntry[] = [];

  for (const rawEntry of input.entries) {
    const normalizedPath = path.normalize(rawEntry.path);
    if (!path.isAbsolute(normalizedPath)) {
      throw toolRecoverableError(`Permission request paths must be absolute: ${rawEntry.path}`, {
        code: "permission_request_path_not_absolute",
        path: rawEntry.path,
      });
    }
    if (normalizedPath === path.parse(normalizedPath).root) {
      throw toolRecoverableError("Permission requests must not target the filesystem root.", {
        code: "permission_request_root_not_allowed",
      });
    }
    if (containsGlobChars(normalizedPath)) {
      throw toolRecoverableError(
        `Permission request paths must not contain glob characters: ${rawEntry.path}`,
        {
          code: "permission_request_path_has_glob",
          path: rawEntry.path,
        },
      );
    }

    if (rawEntry.scope === "subtree") {
      const stats = await safeStat(normalizedPath);
      if (stats == null || !stats.isDirectory()) {
        throw toolRecoverableError(
          `subtree permission requests must target an existing directory: ${normalizedPath}`,
          {
            code: "permission_request_subtree_not_directory",
            path: normalizedPath,
          },
        );
      }
    }

    validateNoHardDenyOverlap({
      ownerAgentId: input.ownerAgentId,
      security: input.security,
      path: normalizedPath,
      scope: rawEntry.scope,
      access: rawEntry.access,
      ...(input.cwd == null ? {} : { cwd: input.cwd }),
    });

    validated.push({
      resource: "filesystem",
      path: normalizedPath,
      scope: rawEntry.scope,
      access: rawEntry.access,
    });
  }

  return validated;
}

function validateNoHardDenyOverlap(input: {
  ownerAgentId: string;
  security: SecurityService;
  path: string;
  scope: PermissionEntryScope;
  access: PermissionAccess;
  cwd?: string;
}): void {
  const kinds =
    input.access === "read"
      ? (["fs.read"] as const)
      : input.access === "write"
        ? (["fs.write"] as const)
        : (["fs.read", "fs.write"] as const);
  const permissions = input.security.getEffectivePermissions(input.ownerAgentId || "missing");

  for (const kind of kinds) {
    const hardDenyPatterns =
      kind === "fs.read" ? permissions.fs.read.hardDeny : permissions.fs.write.hardDeny;
    if (hardDenyPatterns.some((pattern) => overlapsHardDeny(pattern, input.path, input.scope))) {
      throw toolRecoverableError(
        `This permission request overlaps a system-blocked path: ${input.path}`,
        {
          code: "permission_request_hits_hard_deny",
          path: input.path,
          permissionKind: kind,
        },
      );
    }
  }
}

function overlapsHardDeny(
  hardDenyPattern: string,
  requestedPath: string,
  requestedScope: PermissionEntryScope,
): boolean {
  const hardBase = hardDenyPattern.endsWith("/**") ? hardDenyPattern.slice(0, -3) : hardDenyPattern;

  if (requestedScope === "exact") {
    return requestedPath === hardBase || requestedPath.startsWith(`${hardBase}${path.sep}`);
  }

  return (
    requestedPath === hardBase ||
    requestedPath.startsWith(`${hardBase}${path.sep}`) ||
    hardBase.startsWith(`${requestedPath}${path.sep}`)
  );
}

function findLatestPermissionDeniedToolCall(
  db: StorageDb,
  sessionId: string,
  retryToolCallId: string,
): { toolCallId: string; entries: PermissionRequestEntry[] } | null {
  const repo = new MessagesRepo(db);
  const rows = repo.listBySession(sessionId);

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role !== "tool") {
      continue;
    }
    const payload = safeParseToolResultPayload(row);
    if (payload == null || payload.isError !== true || payload.toolCallId !== retryToolCallId) {
      continue;
    }
    const details = payload.details as Record<string, unknown> | undefined;
    if (details?.code !== "permission_denied" || !Array.isArray(details.entries)) {
      continue;
    }

    return {
      toolCallId: retryToolCallId,
      entries: details.entries as PermissionRequestEntry[],
    };
  }

  return null;
}

function safeParseToolResultPayload(row: Message): AgentToolResultPayload | null {
  try {
    return JSON.parse(row.payloadJson) as AgentToolResultPayload;
  } catch {
    return null;
  }
}

function containsGlobChars(value: string): boolean {
  return /[*?[\]]/.test(value);
}

async function safeStat(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}
