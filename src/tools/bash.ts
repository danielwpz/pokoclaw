import { type Static, Type } from "@sinclair/typebox";

import { classifyBashApprovalHelper } from "@/src/security/bash-approval-helpers.js";
import {
  type BashCommandSegment,
  bashPrefixMatchesCommand,
  normalizeBashCommandPrefix,
  type ParsedBashCommandSequence,
  parseConservativeBashCommandSequence,
} from "@/src/security/bash-prefix.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { executeSandboxedBash, executeUnsandboxedBash } from "@/src/security/sandbox.js";
import { SecurityService } from "@/src/security/service.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { toolApprovalRequired, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, type ToolExecutionContext, textToolResult } from "@/src/tools/core/types.js";
import { renderBashResultBlock } from "@/src/tools/helpers/permission-block.js";

const DEFAULT_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 10 * 60;
const MAX_MAIN_CHAT_AGENT_TIMEOUT_SEC = 60;
const MAX_OUTPUT_CHARS = 128_000;
const MISSING_PREFIX_GUIDANCE_CODE = "bash_full_access_missing_prefix";

export const BASH_TOOL_SCHEMA = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      description: "Shell command text to run.",
    }),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the command. Defaults to the session workspace.",
      }),
    ),
    timeoutSec: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_SEC,
        default: DEFAULT_TIMEOUT_SEC,
        description: `Command timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SEC}. Maximum is ${MAX_TIMEOUT_SEC}.`,
      }),
    ),
    sandboxMode: Type.Optional(
      Type.Union([Type.Literal("sandboxed"), Type.Literal("full_access")], {
        default: "sandboxed",
        description:
          "Execution mode. Use sandboxed by default. Use full_access only when this command genuinely needs approved host execution outside the sandbox.",
      }),
    ),
    justification: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Required for full_access. Keep it short and explain why this exact command needs broader execution for the current user request.",
      }),
    ),
    prefix: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 16,
        description:
          "Optional reusable approval scope for a simple stable command family. Add it when similar commands are likely soon; choose narrow or broader prefixes based on the task. Omit it for one-shot commands. Do not use it for compound shell commands.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type BashToolArgs = Static<typeof BASH_TOOL_SCHEMA>;

export interface BashToolDetails {
  command: string;
  cwd: string;
  timeoutMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutChars: number;
  stderrChars: number;
  outputTruncated: boolean;
}

const FULL_ACCESS_JUSTIFICATION_PLACEHOLDER =
  "<one short sentence explaining why this exact command needs full access for the current user request>";

export function createBashTool() {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command in sandboxed or full_access mode. By default it runs sandboxed and returns a structured <bash_result> block with command, cwd, exit_code, stdout, and stderr. The default timeout is 10 seconds. You may override it with timeoutSec, but main chat agents cannot request more than 60 seconds; use a subagent for longer work. If approved host execution outside the sandbox is genuinely necessary, rerun with sandboxMode=full_access and justification. When similar simple commands are likely soon, add prefix so future bash calls can reuse approval; choose the prefix scope based on the task.",
    inputSchema: BASH_TOOL_SCHEMA,
    getInvocationTimeoutMs: getBashInvocationTimeoutMs,
    async execute(context, args) {
      const backgroundReason = detectUnsupportedBackgroundSyntax(args.command);
      if (backgroundReason != null) {
        throw toolRecoverableError(
          `Background shell jobs are not supported yet (${backgroundReason}). Run the command in the foreground.`,
          {
            code: "bash_background_not_supported",
            reason: backgroundReason,
          },
        );
      }

      assertBashTimeoutAllowed(context, args);
      const timeoutMs = getBashInvocationTimeoutMs(context, args);
      const sandboxMode = args.sandboxMode ?? "sandboxed";
      if (sandboxMode !== "full_access" && (args.justification != null || args.prefix != null)) {
        throw toolRecoverableError(buildFullAccessArgsRequireModeMessage(args), {
          code: "bash_full_access_args_require_full_access_mode",
        });
      }
      const security = new SecurityService(
        context.storage,
        buildSystemPolicy({ security: context.securityConfig }),
      );
      const parsedCommandSequence =
        sandboxMode === "full_access"
          ? await parseConservativeBashCommandSequence(args.command)
          : null;
      const normalizedCommandPrefix =
        parsedCommandSequence?.kind === "simple"
          ? (parsedCommandSequence.commands[0]?.argv ?? null)
          : normalizeBashCommandPrefix(args.command);

      const result =
        sandboxMode === "full_access"
          ? await executeBashWithFullAccessIfAllowed({
              context,
              args,
              timeoutMs,
              security,
              normalizedCommandPrefix,
              parsedCommandSequence,
            })
          : await executeSandboxedBash({
              context,
              command: args.command,
              timeoutMs,
              ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            });
      const rendered = renderBashResult({
        ...result,
        hintText: buildSandboxNotFoundHintIfNeeded({
          args,
          sandboxMode,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      });

      return textToolResult(rendered.text, {
        command: result.command,
        cwd: result.cwd,
        timeoutMs: result.timeoutMs,
        exitCode: result.exitCode,
        signal: result.signal,
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
        outputTruncated: rendered.truncated,
      });
    },
  });
}

function getBashInvocationTimeoutMs(_context: ToolExecutionContext, args: BashToolArgs): number {
  return (args.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
}

function assertBashTimeoutAllowed(context: ToolExecutionContext, args: BashToolArgs): void {
  const timeoutSec = args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (context.agentKind === "main" && context.sessionPurpose === "chat") {
    if (timeoutSec > MAX_MAIN_CHAT_AGENT_TIMEOUT_SEC) {
      throw toolRecoverableError(
        `Main-agent bash commands cannot request more than ${MAX_MAIN_CHAT_AGENT_TIMEOUT_SEC} seconds. Use a subagent for longer-running work.`,
        {
          code: "bash_timeout_exceeds_main_agent_limit",
          requestedTimeoutSec: timeoutSec,
          maxTimeoutSec: MAX_MAIN_CHAT_AGENT_TIMEOUT_SEC,
        },
      );
    }
  }
}

async function executeBashWithFullAccessIfAllowed(input: {
  context: ToolExecutionContext;
  args: BashToolArgs;
  timeoutMs: number;
  security: SecurityService;
  normalizedCommandPrefix: string[] | null;
  parsedCommandSequence: ParsedBashCommandSequence | null;
}) {
  const justification = input.args.justification?.trim();
  if (justification == null || justification.length === 0) {
    throw toolRecoverableError(buildRequiresJustificationMessage(input.args), {
      code: "bash_full_access_requires_justification",
    });
  }

  const ownerAgentId = input.context.ownerAgentId;
  if (ownerAgentId == null || ownerAgentId.trim().length === 0) {
    throw toolRecoverableError("bash full_access is missing its owner agent context.", {
      code: "missing_owner_agent",
    });
  }

  if (input.args.prefix != null) {
    if (input.normalizedCommandPrefix == null) {
      throw toolRecoverableError(buildPrefixRequiresSimpleCommandMessage(input.args), {
        code: "bash_full_access_prefix_requires_simple_command",
      });
    }

    if (!bashPrefixMatchesCommand(input.args.prefix, input.normalizedCommandPrefix)) {
      throw toolRecoverableError(buildPrefixNotCommandPrefixMessage(input.args), {
        code: "bash_full_access_prefix_not_command_prefix",
      });
    }
  }

  if (
    hasCurrentToolCallOneShotBashApproval(input.context) ||
    input.context.approvalState?.runtimeModeAutoApproval != null
  ) {
    return await executeUnsandboxedBash({
      context: input.context,
      command: input.args.command,
      timeoutMs: input.timeoutMs,
      ...(input.args.cwd === undefined ? {} : { cwd: input.args.cwd }),
    });
  }

  if (input.parsedCommandSequence != null) {
    const segmentApprovals = input.parsedCommandSequence.commands.map((command) =>
      classifyBashFullAccessSegment({
        context: input.context,
        ownerAgentId,
        security: input.security,
        command,
      }),
    );
    const hasFullAccess = segmentApprovals.every((approval) => approval !== "denied");
    if (hasFullAccess) {
      return await executeUnsandboxedBash({
        context: input.context,
        command: input.args.command,
        timeoutMs: input.timeoutMs,
        ...(input.args.cwd === undefined ? {} : { cwd: input.args.cwd }),
      });
    }
  }

  if (
    input.args.prefix == null &&
    input.normalizedCommandPrefix != null &&
    input.parsedCommandSequence?.kind === "simple" &&
    shouldPromptForMissingFullAccessPrefix({
      context: input.context,
      command: input.args.command,
    })
  ) {
    throw toolRecoverableError(buildMissingPrefixMessage(input.args), {
      code: MISSING_PREFIX_GUIDANCE_CODE,
      command: input.args.command,
      runId: input.context.runId,
    });
  }

  const approvalPrefix = input.args.prefix ?? input.normalizedCommandPrefix ?? ["bash", "-lc"];
  const scope = { kind: "bash.full_access" as const, prefix: approvalPrefix };
  const approvalTitle =
    input.args.prefix == null
      ? "Approval required: run bash command with full access"
      : `Approval required: run bash with full access for prefix ${approvalPrefix.join(" ")}`;

  throw toolApprovalRequired({
    request: { scopes: [scope] },
    reasonText: justification,
    approvalTitle,
    approvalCommand: input.args.command,
    grantOnApprove: input.args.prefix != null,
    ...(input.args.prefix == null
      ? {
          approvalState: {
            bashFullAccess: {
              approved: true,
              mode: "one_shot" as const,
              approvalId: 0,
              ...(input.context.toolCallId == null ? {} : { toolCallId: input.context.toolCallId }),
            },
          },
        }
      : {}),
  });
}

function hasCurrentToolCallOneShotBashApproval(context: ToolExecutionContext): boolean {
  const approval = context.approvalState?.bashFullAccess;
  return (
    approval?.approved === true &&
    approval.toolCallId != null &&
    approval.toolCallId === context.toolCallId
  );
}

function shouldPromptForMissingFullAccessPrefix(input: {
  context: ToolExecutionContext;
  command: string;
}): boolean {
  if (input.context.runId == null) {
    return false;
  }

  if (
    hasMissingPrefixGuidanceForRun({
      context: input.context,
      command: input.command,
    })
  ) {
    return false;
  }

  return true;
}

function hasMissingPrefixGuidanceForRun(input: {
  context: ToolExecutionContext;
  command: string;
}): boolean {
  const runId = input.context.runId;
  if (runId == null) {
    return false;
  }

  const messages = new MessagesRepo(input.context.storage).listBySession(input.context.sessionId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") {
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.payloadJson);
    } catch {
      continue;
    }

    if (typeof payload !== "object" || payload == null) {
      continue;
    }
    const details = (payload as { details?: unknown }).details;
    if (typeof details !== "object" || details == null) {
      continue;
    }

    const candidate = details as {
      code?: unknown;
      command?: unknown;
      runId?: unknown;
    };
    if (
      candidate.code === MISSING_PREFIX_GUIDANCE_CODE &&
      candidate.command === input.command &&
      candidate.runId === runId
    ) {
      return true;
    }
  }

  return false;
}

type BashFullAccessSegmentApproval =
  | "approved"
  | "standalone_helper"
  | "pipeline_helper"
  | "denied";

function classifyBashFullAccessSegment(input: {
  context: ToolExecutionContext;
  ownerAgentId: string;
  security: SecurityService;
  command: BashCommandSegment;
}): BashFullAccessSegmentApproval {
  const access = input.security.checkBashFullAccess({
    ownerAgentId: input.ownerAgentId,
    commandPrefix: input.command.argv,
    ...(input.context.approvalState?.ephemeralPermissionScopes == null
      ? {}
      : { ephemeralScopes: input.context.approvalState.ephemeralPermissionScopes }),
  });
  if (access.result === "allow") {
    return "approved";
  }

  const helperKind = classifyBashApprovalHelper(input.command);
  if (helperKind === "standalone") {
    return "standalone_helper";
  }
  if (helperKind === "pipeline") {
    return "pipeline_helper";
  }

  return "denied";
}

function detectUnsupportedBackgroundSyntax(command: string): string | null {
  const scrubbed = stripQuotedShellContent(command);
  if (findUnquotedBackgroundAmpersand(scrubbed)) {
    return "unmanaged '&' background operator";
  }

  const keywordMatch = scrubbed.match(/\b(nohup|setsid|disown)\b/i);
  if (keywordMatch?.[1] != null) {
    return `unmanaged ${keywordMatch[1]} backgrounding`;
  }

  return null;
}

function buildFullAccessArgsRequireModeMessage(args: BashToolArgs): string {
  const sandboxedRetry = renderBashArgsJson(selectBashArgs(args, { mode: "sandboxed" }));
  const fullAccessRetry = renderBashArgsJson(selectBashArgs(args, { mode: "full_access" }));

  return [
    '`justification` and `prefix` are only valid when `sandboxMode` is `"full_access"`.',
    "",
    'These fields describe a full-access approval request. If you want to stay sandboxed, remove them. If you intend to request broader execution, set `sandboxMode` to `"full_access"`.',
    "",
    "If you want a sandboxed call, use:",
    "```json",
    sandboxedRetry,
    "```",
    "",
    "If you want a full-access call, use:",
    "```json",
    fullAccessRetry,
    "```",
  ].join("\n");
}

function buildRequiresJustificationMessage(args: BashToolArgs): string {
  const retryJson = renderBashArgsJson(
    selectBashArgs(args, { mode: "full_access", requireJustification: true }),
  );

  return [
    "bash full_access requires `justification`.",
    "",
    "`justification` is required because full access runs as approved host execution outside the sandbox. It should briefly explain why this exact command is necessary for the current user request.",
    "",
    "Use this exact bash argument object on the next retry:",
    "```json",
    retryJson,
    "```",
  ].join("\n");
}

function buildPrefixRequiresSimpleCommandMessage(args: BashToolArgs): string {
  const retryJson = renderBashArgsJson(
    selectBashArgs(args, {
      mode: "full_access",
      dropPrefix: true,
      requireJustification: true,
    }),
  );

  return [
    "`prefix` can only be used for a single simple command. This command is compound.",
    "",
    "`prefix` defines a reusable approval scope, so it must describe a stable simple command shape. Compound shell commands should use one-shot full access instead.",
    "",
    "Use this exact bash argument object on the next retry:",
    "```json",
    retryJson,
    "```",
  ].join("\n");
}

function buildPrefixNotCommandPrefixMessage(args: BashToolArgs): string {
  const retryJson = renderBashArgsJson(
    selectBashArgs(args, {
      mode: "full_access",
      dropPrefix: true,
      requireJustification: true,
    }),
  );

  return [
    "`prefix` must match the start of the command's normalized argv.",
    "",
    "`prefix` defines the reusable approval scope, so it must accurately describe the command family being approved. If you are unsure, request one-shot full access without `prefix`.",
    "",
    "Use this exact bash argument object on the next retry:",
    "```json",
    retryJson,
    "```",
  ].join("\n");
}

function buildMissingPrefixMessage(args: BashToolArgs): string {
  return [
    "This simple bash `full_access` call has no `prefix`.",
    "",
    "`prefix` is the reusable approval scope: after approval, later `full_access` commands whose normalized argv starts with that prefix can reuse the grant.",
    "Choose the scope by balancing autonomy and risk: reduce repeated user interruptions, but keep user confirmation when the approved command family would be meaningfully broader or riskier than the task needs.",
    "Before retrying, decide whether this task is likely to need the same command or a closely related command again soon.",
    "- If yes, add a task-appropriate `prefix`: the whole normalized command argv for exact repeats, or a shorter clear command-family prefix for related work.",
    "- If this is genuinely one-off, retry without `prefix`; the next identical request in this run will continue as one-shot.",
    "",
    "Examples:",
    '- Repeated exact test runs: use `["npm","test"]` or the full command argv.',
    '- Ongoing Node or repository work may justify broader prefixes like `["npm"]` or `["git"]` when multiple related subcommands are likely.',
    "- One-off setup/check command: omit `prefix`.",
    "",
    "Retry with the same command and justification. Add `prefix` only if reusable approval is likely to reduce repeated approvals.",
    "Current command:",
    "```json",
    renderBashArgsJson(
      selectBashArgs(args, {
        mode: "full_access",
        requireJustification: true,
        dropPrefix: true,
      }),
    ),
    "```",
  ].join("\n");
}

function selectBashArgs(
  args: BashToolArgs,
  options: {
    mode: "sandboxed" | "full_access";
    dropPrefix?: boolean;
    requireJustification?: boolean;
  },
): Partial<BashToolArgs> {
  const selected: Partial<BashToolArgs> = {
    command: args.command,
  };

  if (args.cwd != null) {
    selected.cwd = args.cwd;
  }
  if (args.timeoutSec != null) {
    selected.timeoutSec = args.timeoutSec;
  }

  if (options.mode === "full_access") {
    selected.sandboxMode = "full_access";
    const justification = args.justification?.trim();
    const resolvedJustification =
      options.requireJustification && (justification == null || justification.length === 0)
        ? FULL_ACCESS_JUSTIFICATION_PLACEHOLDER
        : justification;
    if (resolvedJustification != null) {
      selected.justification = resolvedJustification;
    }
    if (!options.dropPrefix && args.prefix != null) {
      selected.prefix = args.prefix;
    }
  }

  return selected;
}

function renderBashArgsJson(args: Partial<BashToolArgs>): string {
  const ordered: Record<string, unknown> = {};

  if (args.command != null) {
    ordered.command = args.command;
  }
  if (args.cwd != null) {
    ordered.cwd = args.cwd;
  }
  if (args.timeoutSec != null) {
    ordered.timeoutSec = args.timeoutSec;
  }
  if (args.sandboxMode != null) {
    ordered.sandboxMode = args.sandboxMode;
  }
  if (args.justification != null) {
    ordered.justification = args.justification;
  }
  if (args.prefix != null) {
    ordered.prefix = args.prefix;
  }

  return JSON.stringify(ordered, null, 2);
}

function stripQuotedShellContent(command: string): string {
  let result = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      result += " ";
      continue;
    }

    if (quote === '"') {
      if (escaped) {
        escaped = false;
        result += " ";
        continue;
      }
      if (char === "\\") {
        escaped = true;
        result += " ";
        continue;
      }
      if (char === '"') {
        quote = null;
      }
      result += " ";
      continue;
    }

    if (escaped) {
      escaped = false;
      result += " ";
      continue;
    }

    if (char === "\\") {
      escaped = true;
      result += " ";
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }

    result += char;
  }

  return result;
}

function findUnquotedBackgroundAmpersand(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== "&") {
      continue;
    }

    if (isNonBackgroundAmpersand(command, index)) {
      continue;
    }

    return true;
  }

  return false;
}

function isNonBackgroundAmpersand(command: string, index: number): boolean {
  const prev = index > 0 ? command[index - 1] : "";
  const next = index + 1 < command.length ? command[index + 1] : "";

  if (prev === "&" || next === "&") {
    return true;
  }

  // Bash redirection forms like 2>&1, 1>&2, <&0, >&2, &>file, and &>>file
  // use '&' as part of a redirection operator, not as backgrounding.
  if (prev === ">" || prev === "<" || next === ">") {
    return true;
  }

  // Bash pipe shorthand |& pipes stdout+stderr together and is not a
  // background operator.
  if (prev === "|") {
    return true;
  }

  return false;
}

function renderBashResult(input: {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  hintText?: string | null | undefined;
}): { text: string; truncated: boolean } {
  const fullText = renderBashResultSections({
    command: input.command,
    cwd: input.cwd,
    exitCode: input.exitCode,
    signal: input.signal,
    stdout: input.stdout,
    stderr: input.stderr,
    hintText: input.hintText,
  });
  if (fullText.length <= MAX_OUTPUT_CHARS) {
    return {
      text: fullText,
      truncated: false,
    };
  }

  const trimmed = truncateBashStreams({
    stdout: input.stdout,
    stderr: input.stderr,
    maxChars: MAX_OUTPUT_CHARS,
    trailingText: buildBashResultTrailingText({
      truncated: true,
      hintText: input.hintText,
    }),
  });
  return {
    text: renderBashResultSections({
      command: input.command,
      cwd: input.cwd,
      exitCode: input.exitCode,
      signal: input.signal,
      stdout: trimmed.stdout,
      stderr: trimmed.stderr,
      truncated: true,
      hintText: input.hintText,
    }),
    truncated: true,
  };
}

function buildSandboxNotFoundHintIfNeeded(input: {
  args: BashToolArgs;
  sandboxMode: "sandboxed" | "full_access";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): string | null {
  if (input.sandboxMode === "full_access") {
    return null;
  }
  if (input.signal != null) {
    return null;
  }
  if (input.exitCode == null || input.exitCode <= 0) {
    return null;
  }
  if (!looksLikeShellNotFoundFailure({ stdout: input.stdout, stderr: input.stderr })) {
    return null;
  }

  const retryJson = renderBashArgsJson(
    selectBashArgs(input.args, {
      mode: "full_access",
      requireJustification: true,
      dropPrefix: true,
    }),
  );

  return [
    'Hint: this sandboxed bash failure looks like a shell "not found" error.',
    "",
    "In this environment that can be a sandbox symptom rather than proof that the command is truly unavailable.",
    'If this command is normally expected to exist, consider retrying once with `sandboxMode: "full_access"` before concluding it is missing.',
    "",
    "Use this exact bash argument object on the next retry if full access is warranted:",
    "```json",
    retryJson,
    "```",
  ].join("\n");
}

function looksLikeShellNotFoundFailure(input: { stdout: string; stderr: string }): boolean {
  const combined = `${input.stderr}\n${input.stdout}`;
  return SHELL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(combined));
}

const SHELL_NOT_FOUND_PATTERNS: ReadonlyArray<RegExp> = [
  /\bcommand not found\b/i,
  /(?:^|[\r\n])\s*(?:\/[^\s:]+)?(?:bash|zsh|sh):\s+.+?:\s+not found\b/i,
  /(?:^|[\r\n])\s*env:\s+.+?:\s+No such file or directory\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bbad interpreter\b.*\bno such file or directory\b/i,
  /\bcannot execute: required file not found\b/i,
];

function renderBashResultSections(input: {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncated?: boolean;
  hintText?: string | null | undefined;
}): string {
  const base = renderBashResultBlock({
    command: input.command,
    cwd: input.cwd,
    exitCode: input.exitCode,
    signal: input.signal,
    stdout: input.stdout,
    stderr: input.stderr,
  });
  const trailingText = buildBashResultTrailingText({
    truncated: input.truncated ?? false,
    hintText: input.hintText,
  });
  return trailingText.length === 0 ? base : `${base}\n\n${trailingText}`;
}

function buildBashResultTrailingText(input: {
  truncated: boolean;
  hintText?: string | null | undefined;
}): string {
  return [
    ...(input.truncated ? ["(Output truncated.)"] : []),
    ...(input.hintText == null || input.hintText.trim().length === 0 ? [] : [input.hintText]),
  ].join("\n\n");
}

function truncateBashStreams(input: {
  stdout: string;
  stderr: string;
  maxChars: number;
  trailingText?: string;
}) {
  const reserved = 512 + (input.trailingText?.length ?? 0);
  const budget = Math.max(256, input.maxChars - reserved);
  const stdoutBudget = Math.floor(budget * 0.6);
  const stderrBudget = budget - stdoutBudget;

  return {
    stdout: truncateBlock(input.stdout, stdoutBudget),
    stderr: truncateBlock(input.stderr, stderrBudget),
  };
}

function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxChars - 20))}\n...[truncated]...`;
}
