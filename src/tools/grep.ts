import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { executeSandboxedBash } from "@/src/security/sandbox.js";
import { isToolFailure, type ToolFailure, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, type ToolExecutionContext, textToolResult } from "@/src/tools/core/types.js";
import { createFilesystemAccessController, formatDisplayPath } from "@/src/tools/helpers/common.js";
import {
  compileSearchPattern,
  matchesFindPattern,
  toDisplayRelativePath,
  type WalkDirectoryResult,
  type WalkWarning,
  walkDirectory,
} from "@/src/tools/helpers/fs-helpers.js";

const DEFAULT_LIMIT = 200;
const RG_SEARCH_TIMEOUT_MS = 9_500;

export const GREP_TOOL_SCHEMA = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        default: ".",
        description:
          "File or directory to search. Directories are searched recursively. Defaults to the current tool working directory.",
      }),
    ),
    query: Type.String({
      minLength: 1,
      description: "Text or regular expression to search for.",
    }),
    literal: Type.Optional(
      Type.Boolean({
        default: true,
        description:
          "Treat query as a literal string instead of a regular expression. Defaults to true.",
      }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        default: false,
        description: "Use case-sensitive matching. Defaults to false.",
      }),
    ),
    glob: Type.Optional(
      Type.String({
        description: "Optional file-name glob filter such as '*.ts' or 'src/*.md'.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_LIMIT,
        description: `Maximum number of matching lines to return. Defaults to ${DEFAULT_LIMIT}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type GrepToolArgs = Static<typeof GREP_TOOL_SCHEMA>;

export interface GrepToolDetails {
  path: string;
  absolutePath: string;
  query: string;
  literal: boolean;
  caseSensitive: boolean;
  glob: string | null;
  backend: "rg" | "js";
  matches: number;
  searchedFiles?: number;
  skippedBinaryFiles?: number;
  limit: number;
  limitReached: boolean;
  warnings?: Array<{
    path: string;
    errorCode: string | null;
    errorMessage: string;
  }>;
}

export function createGrepTool() {
  return defineTool({
    name: "grep",
    description:
      "Search text within a granted file or directory tree. Returns matching lines with file paths and line numbers.",
    inputSchema: GREP_TOOL_SCHEMA,
    async execute(context, args) {
      const access = createFilesystemAccessController(context);
      const absolutePath = access.require({ kind: "fs.read", targetPath: args.path ?? "." });
      const displayPath = formatDisplayPath(args.path ?? ".", access.cwd);
      const query = args.query;
      const literal = args.literal ?? true;
      const caseSensitive = args.caseSensitive ?? false;
      const glob = args.glob ?? null;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const matcher = compileSearchPattern(query, { literal, ignoreCase: !caseSensitive });

      let rootStats: Awaited<ReturnType<typeof stat>>;
      try {
        rootStats = await stat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw toolRecoverableError(`Path not found: ${displayPath}`, {
            code: "path_not_found",
            path: absolutePath,
          });
        }
        throw error;
      }

      if (
        rootStats.isFile() &&
        glob != null &&
        !matchesFindPattern(glob, displayPath, basename(displayPath))
      ) {
        return textToolResult("(no matches)", {
          path: displayPath,
          absolutePath,
          query,
          literal,
          caseSensitive,
          glob,
          backend: "js",
          matches: 0,
          searchedFiles: 0,
          skippedBinaryFiles: 0,
          limit,
          limitReached: false,
        });
      }

      const rgResult = await tryRipgrepSearch({
        context,
        absolutePath,
        displayPath,
        query,
        literal,
        caseSensitive,
        glob,
        limit,
        rootIsDirectory: rootStats.isDirectory(),
      });
      if (rgResult != null) {
        return rgResult;
      }

      const lines: string[] = [];
      let searchedFiles = 0;
      let skippedBinaryFiles = 0;
      let limitReached = false;
      const warnings: Array<{
        path: string;
        errorCode: string | null;
        errorMessage: string;
      }> = [];

      const searchFile = async (filePath: string, outputPath: string, required: boolean) => {
        const decision = access.check({ kind: "fs.read", targetPath: filePath });
        if (decision.access.result === "deny") {
          return;
        }

        if (glob != null && !matchesFindPattern(glob, outputPath, basename(outputPath))) {
          return;
        }

        let fileBuffer: Awaited<ReturnType<typeof readFile>>;
        try {
          const fileStats = await stat(filePath);
          if (!fileStats.isFile()) {
            return;
          }
          fileBuffer = await readFile(filePath);
        } catch (error) {
          if (isSkippableSearchFileError(error)) {
            if (required) {
              throw toolRecoverableError(`Cannot read file: ${outputPath}`, {
                code: "path_not_readable",
                path: filePath,
                rawMessage: error instanceof Error ? error.message : String(error),
              });
            }

            warnings.push({
              path: outputPath,
              errorCode: error.code,
              errorMessage: error.message,
            });
            return;
          }
          throw error;
        }
        if (fileBuffer.includes(0)) {
          skippedBinaryFiles += 1;
          return;
        }

        searchedFiles += 1;
        const fileText = fileBuffer.toString("utf8");
        const fileLines = splitFileLines(fileText);

        for (let index = 0; index < fileLines.length; index += 1) {
          if (matcher.test(fileLines[index] ?? "")) {
            if (lines.length >= limit) {
              limitReached = true;
              return "stop";
            }

            lines.push(`${outputPath}:${index + 1}| ${fileLines[index]}`);
          }
        }

        return;
      };

      if (rootStats.isFile()) {
        const stop = await searchFile(absolutePath, displayPath, true);
        if (stop === "stop") {
          limitReached = true;
        }
      } else if (rootStats.isDirectory()) {
        let walkResult: WalkDirectoryResult;
        try {
          walkResult = await walkDirectory({
            rootPath: absolutePath,
            onEntry: async (entry) => {
              const decision = access.check({ kind: "fs.read", targetPath: entry.absolutePath });
              if (decision.access.result === "deny") {
                return entry.kind === "directory" ? "skip" : "continue";
              }

              if (entry.kind !== "file") {
                return;
              }

              const outputPath = toDisplayRelativePath(absolutePath, entry.absolutePath);
              return await searchFile(entry.absolutePath, outputPath, false);
            },
          });
        } catch (error) {
          if (isUnreadablePathError(error)) {
            throw toolRecoverableError(`Cannot read directory: ${displayPath}`, {
              code: "path_not_readable",
              path: absolutePath,
              rawMessage: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
        warnings.push(...walkResult.warnings.map(toWarningDetails));
      } else {
        throw toolRecoverableError(`Path is not a searchable file or directory: ${displayPath}`, {
          code: "unsupported_path_type",
          path: absolutePath,
        });
      }

      if (lines.length === 0) {
        return textToolResult("(no matches)", {
          path: displayPath,
          absolutePath,
          query,
          literal,
          caseSensitive,
          glob,
          backend: "js",
          matches: 0,
          searchedFiles,
          skippedBinaryFiles,
          limit,
          limitReached: false,
          ...(warnings.length === 0 ? {} : { warnings }),
        });
      }

      let output = lines.join("\n");
      if (limitReached) {
        output += `\n\n(${limit} matching lines shown. Narrow the query or increase limit for more.)`;
      }
      if (warnings.length > 0) {
        output += `\n\n${formatWalkWarnings(warnings)}`;
      }

      return textToolResult(output, {
        path: displayPath,
        absolutePath,
        query,
        literal,
        caseSensitive,
        glob,
        backend: "js",
        matches: lines.length,
        searchedFiles,
        skippedBinaryFiles,
        limit,
        limitReached,
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    },
  });
}

async function tryRipgrepSearch(input: {
  context: ToolExecutionContext;
  absolutePath: string;
  displayPath: string;
  query: string;
  literal: boolean;
  caseSensitive: boolean;
  glob: string | null;
  limit: number;
  rootIsDirectory: boolean;
}) {
  const workingDirectory = input.rootIsDirectory
    ? input.absolutePath
    : path.dirname(input.absolutePath);
  const searchPath = input.rootIsDirectory ? "." : path.basename(input.absolutePath);
  let result: Awaited<ReturnType<typeof executeSandboxedBash>>;
  try {
    result = await executeSandboxedBash({
      context: input.context,
      command: buildRipgrepCommand({
        searchPath,
        query: input.query,
        literal: input.literal,
        caseSensitive: input.caseSensitive,
        glob: input.glob,
      }),
      timeoutMs: RG_SEARCH_TIMEOUT_MS,
      cwd: workingDirectory,
    });
  } catch (error) {
    if (isToolFailure(error)) {
      if (getToolFailureCode(error) === "bash_timeout") {
        throw toolRecoverableError(`The grep tool timed out after ${RG_SEARCH_TIMEOUT_MS}ms.`, {
          code: "grep_timeout",
          timeoutMs: RG_SEARCH_TIMEOUT_MS,
        });
      }
      throw toolRecoverableError(
        `ripgrep failed while searching ${input.displayPath}: ${error.rawMessage ?? error.message}`,
        {
          code: "grep_rg_failed",
          path: input.absolutePath,
          rawMessage: error.rawMessage ?? error.message,
        },
      );
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    throw toolRecoverableError(
      `ripgrep failed while searching ${input.displayPath}: ${rawMessage}`,
      {
        code: "grep_rg_failed",
        path: input.absolutePath,
        rawMessage,
      },
    );
  }

  if (result.signal != null) {
    throw toolRecoverableError(
      `ripgrep exited unexpectedly while searching ${input.displayPath}.`,
      {
        code: "grep_rg_failed",
        path: input.absolutePath,
        signal: result.signal,
        rawMessage: result.stderr,
      },
    );
  }
  if (result.exitCode === 127 && /command not found/i.test(result.stderr)) {
    return null;
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const stderr = result.stderr.trim();
    throw toolRecoverableError(
      stderr.length === 0
        ? `ripgrep failed while searching ${input.displayPath}.`
        : `ripgrep failed while searching ${input.displayPath}: ${stderr}`,
      {
        code: "grep_rg_failed",
        path: input.absolutePath,
        exitCode: result.exitCode,
        rawMessage: stderr,
      },
    );
  }

  const parsed = parseRipgrepJsonOutput({
    stdout: result.stdout,
    rootPath: input.absolutePath,
    displayPath: input.displayPath,
    rootIsDirectory: input.rootIsDirectory,
    limit: input.limit,
  });
  if (parsed == null) {
    throw toolRecoverableError(
      `ripgrep returned an unexpected output format while searching ${input.displayPath}.`,
      {
        code: "grep_rg_parse_failed",
        path: input.absolutePath,
      },
    );
  }

  if (parsed.lines.length === 0) {
    return textToolResult("(no matches)", {
      path: input.displayPath,
      absolutePath: input.absolutePath,
      query: input.query,
      literal: input.literal,
      caseSensitive: input.caseSensitive,
      glob: input.glob,
      backend: "rg",
      matches: 0,
      ...(parsed.searchedFiles == null ? {} : { searchedFiles: parsed.searchedFiles }),
      limit: input.limit,
      limitReached: false,
    });
  }

  let output = parsed.lines.join("\n");
  if (parsed.limitReached) {
    output += `\n\n(${input.limit} matching lines shown. Narrow the query or increase limit for more.)`;
  }

  return textToolResult(output, {
    path: input.displayPath,
    absolutePath: input.absolutePath,
    query: input.query,
    literal: input.literal,
    caseSensitive: input.caseSensitive,
    glob: input.glob,
    backend: "rg",
    matches: parsed.lines.length,
    ...(parsed.searchedFiles == null ? {} : { searchedFiles: parsed.searchedFiles }),
    limit: input.limit,
    limitReached: parsed.limitReached,
  });
}

function buildRipgrepCommand(input: {
  searchPath: string;
  query: string;
  literal: boolean;
  caseSensitive: boolean;
  glob: string | null;
}): string {
  const args = ["rg", "--json", "--stats", "--no-messages"];

  if (input.literal) {
    args.push("--fixed-strings");
  }
  if (!input.caseSensitive) {
    args.push("--ignore-case");
  }
  if (input.glob != null) {
    args.push("--glob", input.glob);
  }

  args.push("--regexp", input.query, "--", input.searchPath);
  return args.map(quoteShellArg).join(" ");
}

function parseRipgrepJsonOutput(input: {
  stdout: string;
  rootPath: string;
  displayPath: string;
  rootIsDirectory: boolean;
  limit: number;
}): { lines: string[]; limitReached: boolean; searchedFiles: number | null } | null {
  const events = splitFileLines(input.stdout);
  const lines: string[] = [];
  let limitReached = false;
  let searchedFiles: number | null = null;

  for (const eventLine of events) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(eventLine) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = typeof event.type === "string" ? event.type : null;
    if (type === "match") {
      if (lines.length >= input.limit) {
        limitReached = true;
        continue;
      }

      const data = isRecord(event.data) ? event.data : null;
      const matchPath = extractRipgrepPath(data);
      const lineNumber =
        data != null && typeof data.line_number === "number" ? data.line_number : null;
      const lineText = extractRipgrepLineText(data);
      if (matchPath == null || lineNumber == null || lineText == null) {
        return null;
      }

      const outputPath = input.rootIsDirectory
        ? resolveRipgrepOutputPath(input.rootPath, matchPath)
        : input.displayPath;
      lines.push(`${outputPath}:${lineNumber}| ${stripTrailingLineEnding(lineText)}`);
      continue;
    }

    if (type === "summary") {
      const data = isRecord(event.data) ? event.data : null;
      const stats = data != null && isRecord(data.stats) ? data.stats : null;
      searchedFiles = stats != null && typeof stats.searches === "number" ? stats.searches : null;
    }
  }

  return { lines, limitReached, searchedFiles };
}

function splitFileLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function basename(value: string): string {
  const segments = value.split("/");
  return segments.at(-1) ?? value;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnreadablePathError(
  error: unknown,
): error is Error & { code: "EPERM" | "EACCES"; message: string } {
  return (
    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")
  );
}

function isSkippableSearchFileError(error: unknown): error is Error & {
  code: "EACCES" | "ENOENT" | "ENOTDIR" | "EPERM" | "EISDIR";
  message: string;
} {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" ||
      error.code === "EACCES" ||
      error.code === "ENOENT" ||
      error.code === "EISDIR" ||
      error.code === "ENOTDIR")
  );
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stripTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function normalizeRipgrepRelativePath(value: string): string {
  return value
    .replace(/^[.][/\\]/, "")
    .split(path.sep)
    .join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function extractRipgrepPath(data: Record<string, unknown> | null): string | null {
  if (data == null || !isRecord(data.path)) {
    return null;
  }
  return typeof data.path.text === "string" ? data.path.text : null;
}

function resolveRipgrepOutputPath(rootPath: string, matchPath: string): string {
  if (path.isAbsolute(matchPath)) {
    return toDisplayRelativePath(rootPath, matchPath);
  }
  return normalizeRipgrepRelativePath(matchPath);
}

function extractRipgrepLineText(data: Record<string, unknown> | null): string | null {
  if (data == null || !isRecord(data.lines)) {
    return null;
  }
  return typeof data.lines.text === "string" ? data.lines.text : null;
}

function getToolFailureCode(error: ToolFailure): string | null {
  return isRecord(error.details) && typeof error.details.code === "string"
    ? error.details.code
    : null;
}

function toWarningDetails(warning: WalkWarning) {
  return {
    path: warning.relativePath,
    errorCode: warning.errorCode,
    errorMessage: warning.errorMessage,
  };
}

function formatWalkWarnings(
  warnings: Array<{ path: string; errorCode: string | null; errorMessage: string }>,
): string {
  const count = warnings.length;
  const sample = warnings
    .slice(0, 3)
    .map((warning) =>
      warning.errorCode == null ? warning.path : `${warning.path} (${warning.errorCode})`,
    )
    .join(", ");
  const suffix = count > 3 ? `, +${count - 3} more` : "";
  return `Warning: skipped ${count} unreadable path${count === 1 ? "" : "s"}: ${sample}${suffix}`;
}
