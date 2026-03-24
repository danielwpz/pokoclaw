import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeSandboxedCommand,
  isSandboxPermissionError,
  type SandboxExecResult,
  type SandboxPermissionIssue,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import {
  checkFilesystemPermission,
  normalizeFilesystemTargetPath,
} from "@/src/security/permissions.js";
import { buildSystemPolicy, type SystemPermissionPolicy } from "@/src/security/policy.js";
import { describePermissionScope, type PermissionScope } from "@/src/security/scope.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { toolApprovalRequired, toolRecoverableError } from "@/src/tools/errors.js";
import type { ToolExecutionContext } from "@/src/tools/types.js";

export interface BuildSandboxConfigForAgentInput {
  storage: StorageDb;
  ownerAgentId: string;
  systemPolicy?: SystemPermissionPolicy;
  activeAt?: Date;
}

export interface ExecuteSandboxedBashInput {
  context: ToolExecutionContext;
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface SandboxedBashResult extends SandboxExecResult {
  command: string;
  cwd: string;
  timeoutMs: number;
}

const logger = createSubsystemLogger("security/sandbox");
const DEFAULT_BASH_BINARY = process.platform === "win32" ? "bash" : "/bin/bash";
const BLOCKED_ENV_VAR_NAMES = new Set<string>([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECRET_KEY",
  "AWS_SESSION_TOKEN",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "SHELL",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "HISTFILE",
]);
const BLOCKED_ENV_VAR_PREFIXES: ReadonlyArray<string> = ["BASH_FUNC_", "DYLD_", "LD_"];
const BLOCKED_ENV_VAR_PATTERNS: ReadonlyArray<RegExp> = [
  /^SLACK_(BOT|APP)_TOKEN$/i,
  /^(GH|GITHUB)_TOKEN$/i,
  /^(AZURE|AZURE_OPENAI|COHERE|AI_GATEWAY|OPENROUTER)_API_KEY$/i,
  /_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/i,
];

// This adapter is the only place that should know how Pokeclaw's permission
// model maps onto sandbox-runtime's config surface.
export function buildSandboxConfigForAgent(
  input: BuildSandboxConfigForAgentInput,
): SandboxRuntimeConfig {
  const systemPolicy = input.systemPolicy ?? buildSystemPolicy();
  const security = new SecurityService(input.storage, systemPolicy);
  const permissions = security.getEffectivePermissions(input.ownerAgentId, input.activeAt);

  return {
    filesystem: {
      readMode: permissions.fs.read.mode,
      denyRead: dedupeStrings([...permissions.fs.read.hardDeny, ...permissions.fs.read.deny]),
      allowRead: permissions.fs.read.allow,
      allowWrite: permissions.fs.write.allow,
      denyWrite: dedupeStrings([...permissions.fs.write.hardDeny, ...permissions.fs.write.deny]),
    },
    network: {
      mode: "deny_only",
      allowedDomains: [],
      deniedDomains: dedupeStrings(systemPolicy.network.hardDenyHosts),
    },
  };
}

// This is the only execution path that should talk to sandbox-runtime directly.
// It keeps shell semantics, timeout handling, env sanitization, and
// permission-block translation out of the bash tool itself.
export async function executeSandboxedBash(
  input: ExecuteSandboxedBashInput,
): Promise<SandboxedBashResult> {
  const ownerAgentId = requireOwnerAgentId(input.context);
  const systemPolicy = buildSystemPolicy({ security: input.context.securityConfig });
  const security = new SecurityService(input.context.storage, systemPolicy);
  const cwd = await resolveSandboxCwd({
    context: input.context,
    security,
    ...(input.cwd === undefined ? {} : { requestedCwd: input.cwd }),
  });
  const sandboxConfig = buildSandboxConfigForAgent({
    storage: input.context.storage,
    ownerAgentId,
    systemPolicy,
  });
  const timeout = Math.max(1, Math.floor(input.timeoutMs));
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeout);
  const abortSignal =
    input.context.abortSignal == null
      ? timeoutController.signal
      : AbortSignal.any([input.context.abortSignal, timeoutController.signal]);

  logger.info("bash sandbox exec start", {
    sessionId: input.context.sessionId,
    ownerAgentId,
    toolCallId: input.context.toolCallId,
    cwd: shortenPathForLog(cwd),
    timeoutMs: timeout,
    command: truncateForLog(input.command),
  });

  try {
    const result = await executeSandboxedCommand(input.command, {
      binShell: DEFAULT_BASH_BINARY,
      customConfig: sandboxConfig,
      abortSignal,
      cwd,
      env: sanitizeSandboxEnv(process.env),
    });

    logger.info("bash sandbox exec done", {
      sessionId: input.context.sessionId,
      ownerAgentId,
      toolCallId: input.context.toolCallId,
      exitCode: result.exitCode,
      signal: result.signal,
      cwd: shortenPathForLog(cwd),
    });

    return {
      ...result,
      command: input.command,
      cwd,
      timeoutMs: timeout,
    };
  } catch (error) {
    if (isSandboxPermissionError(error)) {
      logger.info("bash sandbox exec blocked", {
        sessionId: input.context.sessionId,
        ownerAgentId,
        toolCallId: input.context.toolCallId,
        issueCount: error.issues.length,
        issue: describeSandboxIssueForLog(error.issues[0]),
      });
      throw translateSandboxPermissionError({
        context: input.context,
        ownerAgentId,
        security,
        error,
        cwd,
      });
    }

    if (
      isAbortError(error) &&
      timeoutController.signal.aborted &&
      !input.context.abortSignal?.aborted
    ) {
      logger.info("bash sandbox exec timeout", {
        sessionId: input.context.sessionId,
        ownerAgentId,
        toolCallId: input.context.toolCallId,
        timeoutMs: timeout,
        cwd: shortenPathForLog(cwd),
      });
      throw toolRecoverableError(`The bash command timed out after ${timeout}ms.`, {
        code: "bash_timeout",
        timeoutMs: timeout,
        cwd,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveSandboxCwd(input: {
  requestedCwd?: string;
  context: ToolExecutionContext;
  security: SecurityService;
}): Promise<string> {
  const fallbackCwd =
    input.context.cwd == null || input.context.cwd.trim().length === 0
      ? POKECLAW_WORKSPACE_DIR
      : input.context.cwd;
  const candidate = input.requestedCwd == null ? fallbackCwd : input.requestedCwd;
  const normalizedPath = normalizeFilesystemTargetPath(candidate, fallbackCwd);
  const access = input.security.checkFilesystemAccess({
    ownerAgentId: requireOwnerAgentId(input.context),
    kind: "fs.read",
    targetPath: normalizedPath,
    cwd: fallbackCwd,
  });

  if (access.result === "deny" && access.reason === "hard_deny") {
    throw toolRecoverableError(
      `The bash working directory is blocked by system policy: ${normalizedPath}`,
      {
        code: "bash_cwd_denied",
        path: normalizedPath,
        accessReason: access.reason,
      },
    );
  }

  if (access.result === "deny") {
    throw toolApprovalRequired({
      request: {
        scopes: [{ kind: "fs.read", path: normalizedPath }],
      },
      reasonText: `This tool needs approval to continue: ${describePermissionScope({
        kind: "fs.read",
        path: normalizedPath,
      })}.`,
    });
  }

  let cwdStats: Awaited<ReturnType<typeof stat>>;
  try {
    cwdStats = await stat(normalizedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw toolRecoverableError(`Working directory not found: ${normalizedPath}`, {
        code: "bash_cwd_not_found",
        path: normalizedPath,
      });
    }
    throw error;
  }

  if (!cwdStats.isDirectory()) {
    throw toolRecoverableError(`Working directory is not a directory: ${normalizedPath}`, {
      code: "bash_cwd_not_directory",
      path: normalizedPath,
    });
  }

  return normalizedPath;
}

function translateSandboxPermissionError(input: {
  context: ToolExecutionContext;
  ownerAgentId: string;
  security: SecurityService;
  error: { issues: SandboxPermissionIssue[] };
  cwd: string;
}): Error {
  const requestedScopes = new Map<string, PermissionScope>();

  for (const issue of input.error.issues) {
    if (issue.kind === "network") {
      const target = issue.port == null ? issue.host : `${issue.host}:${issue.port}`;
      return toolRecoverableError(`The bash command is blocked by network policy: ${target}`, {
        code: "bash_network_denied",
        host: issue.host,
        port: issue.port ?? null,
        detail: issue.detail,
      });
    }

    const access = checkFilesystemPermission({
      kind: issue.kind,
      targetPath: issue.path,
      cwd: input.cwd,
      permissions: input.security.getEffectivePermissions(input.ownerAgentId),
    });

    if (access.result === "deny" && access.reason === "hard_deny") {
      const action = issue.kind === "fs.read" ? "read" : "write";
      return toolRecoverableError(
        `The bash command is blocked by system policy: ${action} ${issue.path}`,
        {
          code: "bash_filesystem_denied",
          permissionKind: issue.kind,
          path: issue.path,
          detail: issue.detail,
        },
      );
    }

    requestedScopes.set(`${issue.kind}:${issue.path}`, {
      kind: issue.kind,
      path: issue.path,
    });
  }

  const scopes = [...requestedScopes.values()];
  if (scopes.length === 0) {
    return toolRecoverableError("The bash command was blocked by sandbox policy.", {
      code: "bash_permission_denied",
    });
  }

  return toolApprovalRequired({
    request: { scopes },
    reasonText: buildPermissionApprovalReason(scopes),
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

function requireOwnerAgentId(context: ToolExecutionContext): string {
  if (context.ownerAgentId == null || context.ownerAgentId.trim().length === 0) {
    throw toolRecoverableError(
      "This tool call is missing its owner agent context, so the permission check cannot run.",
      { code: "missing_owner_agent" },
    );
  }

  return context.ownerAgentId;
}

function buildPermissionApprovalReason(scopes: PermissionScope[]): string {
  const firstScope = scopes[0];
  if (scopes.length === 1 && firstScope != null) {
    return `This tool needs approval to continue: ${describePermissionScope(firstScope)}.`;
  }

  return `This tool needs approval to continue: ${scopes.map(describePermissionScope).join("; ")}.`;
}

function sanitizeSandboxEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, rawValue] of Object.entries(baseEnv)) {
    if (rawValue == null) {
      continue;
    }

    const normalizedKey = key.toUpperCase();
    if (
      BLOCKED_ENV_VAR_NAMES.has(normalizedKey) ||
      BLOCKED_ENV_VAR_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix)) ||
      BLOCKED_ENV_VAR_PATTERNS.some((pattern) => pattern.test(key))
    ) {
      continue;
    }

    sanitized[key] = rawValue;
  }

  sanitized.HOME ??= os.homedir();
  sanitized.PATH ??= process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  sanitized.SHELL = DEFAULT_BASH_BINARY;
  sanitized.USER ??= process.env.USER ?? process.env.LOGNAME;
  sanitized.LOGNAME ??= process.env.LOGNAME ?? process.env.USER;

  return sanitized;
}

function describeSandboxIssueForLog(issue: SandboxPermissionIssue | undefined): string | undefined {
  if (issue == null) {
    return undefined;
  }

  if (issue.kind === "network") {
    return issue.port == null ? issue.host : `${issue.host}:${issue.port}`;
  }

  return shortenPathForLog(issue.path);
}

function truncateForLog(value: string, maxLength = 80): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxLength - 1))}…`;
}

function shortenPathForLog(value: string): string {
  const homeDir = os.homedir();
  if (value.startsWith(`${homeDir}${path.sep}`)) {
    return `~/${value.slice(homeDir.length + 1)}`;
  }
  if (value === homeDir) {
    return "~";
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
