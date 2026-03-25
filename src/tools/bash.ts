import { type Static, Type } from "@sinclair/typebox";

import {
  bashPrefixMatchesCommand,
  normalizeBashCommandPrefix,
} from "@/src/security/bash-prefix.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { executeSandboxedBash, executeUnsandboxedBash } from "@/src/security/sandbox.js";
import { SecurityService } from "@/src/security/service.js";
import { toolApprovalRequired, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, type ToolExecutionContext, textToolResult } from "@/src/tools/core/types.js";
import { renderBashResultBlock } from "@/src/tools/helpers/permission-block.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 128_000;

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
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
        description: `Command timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      }),
    ),
    sandboxMode: Type.Optional(
      Type.Union([Type.Literal("sandboxed"), Type.Literal("full_access")], {
        default: "sandboxed",
        description:
          "Use sandboxed for normal execution. Use full_access only when this command genuinely needs to run outside the sandbox.",
      }),
    ),
    justification: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Required when requesting full_access. Keep it short and explain why full access is necessary for the current user request.",
      }),
    ),
    prefix: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 16,
        description:
          'Optional reusable command prefix for long-lived full-access approval. Only use this for a single simple command shape such as ["npm","run"] or ["python","-m","agent_browser_cli"]. Do not use it for compound shell commands.',
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

export function createBashTool() {
  return defineTool({
    name: "bash",
    description:
      "Run a shell command. By default it runs in the sandbox and returns a structured <bash_result> block with command, cwd, exit_code, stdout, and stderr. If sandboxed execution is blocked but the command is genuinely necessary, rerun bash with sandboxMode=full_access and a short justification. Optional prefix enables a reusable long-lived approval, but only for a single simple command shape.",
    inputSchema: BASH_TOOL_SCHEMA,
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

      const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const sandboxMode = args.sandboxMode ?? "sandboxed";
      if (sandboxMode !== "full_access" && (args.justification != null || args.prefix != null)) {
        throw toolRecoverableError(
          "bash justification and prefix are only valid when sandboxMode is full_access.",
          { code: "bash_full_access_args_require_full_access_mode" },
        );
      }
      const security = new SecurityService(
        context.storage,
        buildSystemPolicy({ security: context.securityConfig }),
      );
      const normalizedCommandPrefix = normalizeBashCommandPrefix(args.command);

      const result =
        sandboxMode === "full_access"
          ? await executeBashWithFullAccessIfAllowed({
              context,
              args,
              timeoutMs,
              security,
              normalizedCommandPrefix,
            })
          : await executeSandboxedBash({
              context,
              command: args.command,
              timeoutMs,
              ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            });
      const rendered = renderBashResult(result);

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

async function executeBashWithFullAccessIfAllowed(input: {
  context: ToolExecutionContext;
  args: BashToolArgs;
  timeoutMs: number;
  security: SecurityService;
  normalizedCommandPrefix: string[] | null;
}) {
  const justification = input.args.justification?.trim();
  if (justification == null || justification.length === 0) {
    throw toolRecoverableError(
      "bash full_access requires a short justification that explains why full access is necessary.",
      { code: "bash_full_access_requires_justification" },
    );
  }

  const ownerAgentId = input.context.ownerAgentId;
  if (ownerAgentId == null || ownerAgentId.trim().length === 0) {
    throw toolRecoverableError("bash full_access is missing its owner agent context.", {
      code: "missing_owner_agent",
    });
  }

  if (input.args.prefix != null) {
    if (input.normalizedCommandPrefix == null) {
      throw toolRecoverableError(
        "A reusable bash full-access prefix is only allowed for a single simple command. Complex shell commands can only request one-shot full access.",
        { code: "bash_full_access_prefix_requires_simple_command" },
      );
    }

    if (!bashPrefixMatchesCommand(input.args.prefix, input.normalizedCommandPrefix)) {
      throw toolRecoverableError(
        "The requested bash full-access prefix must match the start of the command's normalized argv.",
        { code: "bash_full_access_prefix_not_command_prefix" },
      );
    }
  }

  if (input.context.approvalState?.bashFullAccess?.approved === true) {
    return await executeUnsandboxedBash({
      context: input.context,
      command: input.args.command,
      timeoutMs: input.timeoutMs,
      ...(input.args.cwd === undefined ? {} : { cwd: input.args.cwd }),
    });
  }

  if (input.normalizedCommandPrefix != null) {
    const access = input.security.checkBashFullAccess({
      ownerAgentId,
      commandPrefix: input.normalizedCommandPrefix,
    });
    if (access.result === "allow") {
      return await executeUnsandboxedBash({
        context: input.context,
        command: input.args.command,
        timeoutMs: input.timeoutMs,
        ...(input.args.cwd === undefined ? {} : { cwd: input.args.cwd }),
      });
    }
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
    grantOnApprove: input.args.prefix != null,
    ...(input.args.prefix == null
      ? {
          approvalState: {
            bashFullAccess: {
              approved: true,
              mode: "one_shot" as const,
              approvalId: 0,
            },
          },
        }
      : {}),
  });
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

    const prev = index > 0 ? command[index - 1] : "";
    const next = index + 1 < command.length ? command[index + 1] : "";
    if (prev === "&" || next === "&") {
      continue;
    }

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
}): { text: string; truncated: boolean } {
  const fullText = renderBashResultBlock({
    command: input.command,
    cwd: input.cwd,
    exitCode: input.exitCode,
    signal: input.signal,
    stdout: input.stdout,
    stderr: input.stderr,
  });
  if (fullText.length <= MAX_OUTPUT_CHARS) {
    return {
      text: fullText,
      truncated: false,
    };
  }

  const trimmed = truncateBashStreams(input.stdout, input.stderr, MAX_OUTPUT_CHARS);
  return {
    text: `${renderBashResultBlock({
      command: input.command,
      cwd: input.cwd,
      exitCode: input.exitCode,
      signal: input.signal,
      stdout: trimmed.stdout,
      stderr: trimmed.stderr,
    })}\n\n(Output truncated.)`,
    truncated: true,
  };
}

function truncateBashStreams(stdout: string, stderr: string, maxChars: number) {
  const reserved = 512;
  const budget = Math.max(256, maxChars - reserved);
  const stdoutBudget = Math.floor(budget * 0.6);
  const stderrBudget = budget - stdoutBudget;

  return {
    stdout: truncateBlock(stdout, stdoutBudget),
    stderr: truncateBlock(stderr, stderrBudget),
  };
}

function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxChars - 20))}\n...[truncated]...`;
}
