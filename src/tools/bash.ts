import { type Static, Type } from "@sinclair/typebox";

import { executeSandboxedBash } from "@/src/security/sandbox.js";
import { toolRecoverableError } from "@/src/tools/errors.js";
import { defineTool, textToolResult } from "@/src/tools/types.js";

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
      "Run a shell command in the agent sandbox. Non-zero exits are returned as normal command results.",
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

      const result = await executeSandboxedBash({
        context,
        command: args.command,
        timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): { text: string; truncated: boolean } {
  const sections: string[] = [];

  if (input.stdout.length > 0) {
    sections.push(input.stdout);
  }

  if (input.stderr.length > 0) {
    sections.push(input.stdout.length > 0 ? `stderr:\n${input.stderr}` : input.stderr);
  }

  if (sections.length === 0) {
    sections.push("(Command completed with no output.)");
  }

  let footer = "";
  if (input.signal != null) {
    footer = `(Command terminated by signal ${input.signal}.)`;
  } else if (input.exitCode != null && input.exitCode !== 0) {
    footer = `(Command exited with code ${input.exitCode}.)`;
  }

  const baseText = sections.join("\n\n");
  const fullText =
    footer.length === 0
      ? baseText
      : `${baseText}${baseText.endsWith("\n") ? "\n" : "\n\n"}${footer}`;
  if (fullText.length <= MAX_OUTPUT_CHARS) {
    return {
      text: fullText,
      truncated: false,
    };
  }

  return {
    text: `${fullText.slice(0, MAX_OUTPUT_CHARS - 20)}\n\n(Output truncated.)`,
    truncated: true,
  };
}
