import { readFile, stat } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createFilesystemAccessController, formatDisplayPath } from "@/src/tools/helpers/common.js";
import {
  compileSearchPattern,
  matchesFindPattern,
  toDisplayRelativePath,
  walkDirectory,
} from "@/src/tools/helpers/fs-helpers.js";

const DEFAULT_LIMIT = 200;

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
  matches: number;
  searchedFiles: number;
  skippedBinaryFiles: number;
  limit: number;
  limitReached: boolean;
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

      const lines: string[] = [];
      let searchedFiles = 0;
      let skippedBinaryFiles = 0;
      let limitReached = false;

      const searchFile = async (filePath: string, outputPath: string) => {
        const decision = access.check({ kind: "fs.read", targetPath: filePath });
        if (decision.access.result === "deny") {
          return;
        }

        if (glob != null && !matchesFindPattern(glob, outputPath, basename(outputPath))) {
          return;
        }

        const fileBuffer = await readFile(filePath);
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
        const stop = await searchFile(absolutePath, displayPath);
        if (stop === "stop") {
          limitReached = true;
        }
      } else if (rootStats.isDirectory()) {
        await walkDirectory({
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
            return await searchFile(entry.absolutePath, outputPath);
          },
        });
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
          matches: 0,
          searchedFiles,
          skippedBinaryFiles,
          limit,
          limitReached: false,
        });
      }

      let output = lines.join("\n");
      if (limitReached) {
        output += `\n\n(${limit} matching lines shown. Narrow the query or increase limit for more.)`;
      }

      return textToolResult(output, {
        path: displayPath,
        absolutePath,
        query,
        literal,
        caseSensitive,
        glob,
        matches: lines.length,
        searchedFiles,
        skippedBinaryFiles,
        limit,
        limitReached,
      });
    },
  });
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
