import { readFile, stat } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";

import { formatDisplayPath, requireFilesystemAccess, resolveToolCwd } from "@/src/tools/common.js";
import { toolRecoverableError } from "@/src/tools/errors.js";
import { defineTool, textToolResult } from "@/src/tools/types.js";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_RESULT_CHARS = 128_000;

export const READ_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String({
      description: "Absolute or relative path to the file to read.",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: 1,
        description: "1-based line number to start reading from. Defaults to 1.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_LINE_LIMIT,
        description: `Maximum number of lines to read. Defaults to ${DEFAULT_LINE_LIMIT}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type ReadToolArgs = Static<typeof READ_TOOL_SCHEMA>;

export interface ReadToolDetails {
  path: string;
  absolutePath: string;
  offset: number;
  limit: number;
  totalLines: number;
  endLine: number;
}

export function createReadTool() {
  return defineTool({
    name: "read",
    description:
      "Read a text file from disk. Returns numbered lines and supports offset/limit pagination.",
    inputSchema: READ_TOOL_SCHEMA,
    async execute(context, args) {
      const cwd = resolveToolCwd(context);
      const absolutePath = requireFilesystemAccess(context, {
        kind: "fs.read",
        targetPath: args.path,
      });
      const displayPath = formatDisplayPath(args.path, cwd);
      const offset = args.offset ?? 1;
      const limit = args.limit ?? DEFAULT_LINE_LIMIT;

      let fileStats: Awaited<ReturnType<typeof stat>>;
      try {
        fileStats = await stat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw toolRecoverableError(`File not found: ${displayPath}`, {
            code: "file_not_found",
            path: absolutePath,
          });
        }
        throw error;
      }

      if (!fileStats.isFile()) {
        throw toolRecoverableError(`Path is not a regular file: ${displayPath}`, {
          code: "not_a_file",
          path: absolutePath,
        });
      }

      const text = await readFile(absolutePath, "utf8");
      const allLines = splitFileLines(text);
      const totalLines = allLines.length;
      if (totalLines === 1 && allLines[0] === "") {
        return textToolResult(`(Empty file: ${displayPath})`, {
          path: displayPath,
          absolutePath,
          offset,
          limit,
          totalLines: 0,
          endLine: 0,
        });
      }

      if (offset > totalLines) {
        throw toolRecoverableError(
          `Line ${offset} is beyond the end of ${displayPath} (${totalLines} lines).`,
          {
            code: "offset_out_of_range",
            path: absolutePath,
            totalLines,
          },
        );
      }

      const startIndex = offset - 1;
      let endIndexExclusive = Math.min(startIndex + limit, totalLines);
      let numberedLines = formatNumberedLines(
        allLines.slice(startIndex, endIndexExclusive),
        offset,
      );
      let body = numberedLines.join("\n");

      if (body.length > MAX_RESULT_CHARS) {
        const trimmedLines: string[] = [];
        let chars = 0;

        for (const line of numberedLines) {
          const projected = chars + line.length + 1;
          if (projected > MAX_RESULT_CHARS) {
            break;
          }
          trimmedLines.push(line);
          chars = projected;
        }

        numberedLines = trimmedLines;
        endIndexExclusive = startIndex + trimmedLines.length;
        body = trimmedLines.join("\n");
      }

      const endLine = endIndexExclusive;
      const footer =
        endLine < totalLines
          ? `\n\n(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
          : `\n\n(End of file. ${totalLines} lines total.)`;

      return textToolResult(`${body}${footer}`, {
        path: displayPath,
        absolutePath,
        offset,
        limit,
        totalLines,
        endLine,
      });
    },
  });
}

function formatNumberedLines(lines: string[], startingLine: number): string[] {
  return lines.map((line, index) => `${startingLine + index}| ${line}`);
}

function splitFileLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
