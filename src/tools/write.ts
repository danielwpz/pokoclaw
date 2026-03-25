import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import {
  formatDisplayPath,
  requireFilesystemAccess,
  resolveToolCwd,
} from "@/src/tools/helpers/common.js";

export const WRITE_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String({
      description: "Absolute or relative path to the file to write.",
    }),
    content: Type.String({
      description: "UTF-8 text content to write to the file.",
    }),
  },
  { additionalProperties: false },
);

export type WriteToolArgs = Static<typeof WRITE_TOOL_SCHEMA>;

export interface WriteToolDetails {
  path: string;
  absolutePath: string;
  bytesWritten: number;
}

export function createWriteTool() {
  return defineTool({
    name: "write",
    description:
      "Write text content to a file on disk. Creates parent directories when needed and overwrites existing files.",
    inputSchema: WRITE_TOOL_SCHEMA,
    async execute(context, args) {
      const cwd = resolveToolCwd(context);
      const absolutePath = requireFilesystemAccess(context, {
        kind: "fs.write",
        targetPath: args.path,
      });
      const displayPath = formatDisplayPath(args.path, cwd);

      try {
        const existingStats = await stat(absolutePath);
        if (!existingStats.isFile()) {
          throw toolRecoverableError(`Path is not a regular file: ${displayPath}`, {
            code: "not_a_file",
            path: absolutePath,
          });
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }

      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, args.content, "utf8");

      const bytesWritten = Buffer.byteLength(args.content, "utf8");

      return textToolResult(`Wrote ${bytesWritten} bytes to ${displayPath}.`, {
        path: displayPath,
        absolutePath,
        bytesWritten,
      });
    },
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
