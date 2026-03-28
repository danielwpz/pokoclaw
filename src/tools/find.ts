import { stat } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createFilesystemAccessController, formatDisplayPath } from "@/src/tools/helpers/common.js";
import {
  matchesFindPattern,
  toDisplayRelativePath,
  type WalkDirectoryResult,
  type WalkWarning,
  walkDirectory,
} from "@/src/tools/helpers/fs-helpers.js";

const DEFAULT_LIMIT = 200;
const FIND_TYPE_VALUES = ["any", "file", "directory"] as const;

export const FIND_TOOL_SCHEMA = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        default: ".",
        description: "Directory to search. Defaults to the current tool working directory.",
      }),
    ),
    pattern: Type.Optional(
      Type.String({
        default: "*",
        description:
          "Glob-style name pattern to match. Patterns without '/' match basenames; patterns with '/' match relative paths.",
      }),
    ),
    type: Type.Optional(
      Type.Union(
        FIND_TYPE_VALUES.map((value) => Type.Literal(value)),
        {
          default: "any",
          description: "Filter matches by entry type. Defaults to 'any'.",
        },
      ),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_LIMIT,
        description: `Maximum number of matches to return. Defaults to ${DEFAULT_LIMIT}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type FindToolArgs = Static<typeof FIND_TOOL_SCHEMA>;

export interface FindToolDetails {
  path: string;
  absolutePath: string;
  pattern: string;
  type: "any" | "file" | "directory";
  matches: number;
  visitedEntries: number;
  limit: number;
  limitReached: boolean;
  warnings?: Array<{
    path: string;
    errorCode: string | null;
    errorMessage: string;
  }>;
}

export function createFindTool() {
  return defineTool({
    name: "find",
    description:
      "Recursively search a granted directory for files or directories by glob-style name pattern.",
    inputSchema: FIND_TOOL_SCHEMA,
    async execute(context, args) {
      const access = createFilesystemAccessController(context);
      const absolutePath = access.require({ kind: "fs.read", targetPath: args.path ?? "." });
      const displayPath = formatDisplayPath(args.path ?? ".", access.cwd);
      const pattern = args.pattern ?? "*";
      const typeFilter = args.type ?? "any";
      const limit = args.limit ?? DEFAULT_LIMIT;

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

      if (!rootStats.isDirectory()) {
        throw toolRecoverableError(`Not a directory: ${displayPath}`, {
          code: "not_a_directory",
          path: absolutePath,
        });
      }

      const matches: string[] = [];
      let visitedEntries = 0;
      let limitReached = false;

      let walkResult: WalkDirectoryResult;
      try {
        walkResult = await walkDirectory({
          rootPath: absolutePath,
          onEntry: async (entry) => {
            const decision = access.check({ kind: "fs.read", targetPath: entry.absolutePath });
            if (decision.access.result === "deny") {
              return entry.kind === "directory" ? "skip" : "continue";
            }

            visitedEntries += 1;

            if (typeFilter !== "any" && entry.kind !== typeFilter) {
              return;
            }

            if (!matchesFindPattern(pattern, entry.relativePath, entry.name)) {
              return;
            }

            if (matches.length >= limit) {
              limitReached = true;
              return "stop";
            }

            const displayMatch = toDisplayRelativePath(absolutePath, entry.absolutePath);
            matches.push(entry.kind === "directory" ? `${displayMatch}/` : displayMatch);
            return;
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

      const warnings = walkResult.warnings.map(toWarningDetails);

      if (matches.length === 0) {
        return textToolResult("(no matches)", {
          path: displayPath,
          absolutePath,
          pattern,
          type: typeFilter,
          matches: 0,
          visitedEntries,
          limit,
          limitReached: false,
          ...(warnings.length === 0 ? {} : { warnings }),
        });
      }

      let output = matches.join("\n");
      if (limitReached) {
        output += `\n\n(${limit} matches shown. Narrow the pattern or increase limit for more.)`;
      }
      if (warnings.length > 0) {
        output += `\n\n${formatWalkWarnings(warnings)}`;
      }

      return textToolResult(output, {
        path: displayPath,
        absolutePath,
        pattern,
        type: typeFilter,
        matches: matches.length,
        visitedEntries,
        limit,
        limitReached,
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    },
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnreadablePathError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")
  );
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
  return `Warning: skipped ${count} unreadable director${count === 1 ? "y" : "ies"}: ${sample}${suffix}`;
}
