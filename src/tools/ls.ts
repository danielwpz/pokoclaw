import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";

import { createFilesystemAccessController, formatDisplayPath } from "@/src/tools/common.js";
import { toolRecoverableError } from "@/src/tools/errors.js";
import { defineTool, textToolResult } from "@/src/tools/types.js";

const DEFAULT_LIMIT = 500;

export const LS_TOOL_SCHEMA = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        default: ".",
        description: "Directory to list. Defaults to the current tool working directory.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_LIMIT,
        description: `Maximum number of visible entries to return. Defaults to ${DEFAULT_LIMIT}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export type LsToolArgs = Static<typeof LS_TOOL_SCHEMA>;

export interface LsToolDetails {
  path: string;
  absolutePath: string;
  visibleEntries: number;
  totalEntries: number;
  entryLimitReached: boolean;
}

export function createLsTool() {
  return defineTool({
    name: "ls",
    description:
      "List directory contents. Returns visible entries sorted alphabetically and appends '/' to directories.",
    inputSchema: LS_TOOL_SCHEMA,
    async execute(context, args) {
      const access = createFilesystemAccessController(context);
      const absolutePath = access.require({ kind: "fs.read", targetPath: args.path ?? "." });
      const displayPath = formatDisplayPath(args.path ?? ".", access.cwd);
      const limit = args.limit ?? DEFAULT_LIMIT;

      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        stats = await stat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw toolRecoverableError(`Path not found: ${displayPath}`, {
            code: "path_not_found",
            path: absolutePath,
          });
        }
        throw error;
      }

      if (!stats.isDirectory()) {
        throw toolRecoverableError(`Not a directory: ${displayPath}`, {
          code: "not_a_directory",
          path: absolutePath,
        });
      }

      const entries = await readdir(absolutePath, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );

      const visibleEntries: string[] = [];
      let totalVisibleEntries = 0;
      let entryLimitReached = false;

      for (const entry of entries) {
        const childPath = path.join(absolutePath, entry.name);
        const decision = access.check({ kind: "fs.read", targetPath: childPath });
        if (decision.access.result === "deny") {
          continue;
        }

        totalVisibleEntries += 1;
        if (visibleEntries.length >= limit) {
          entryLimitReached = true;
          continue;
        }

        const suffix = entry.isDirectory() ? "/" : "";
        visibleEntries.push(`${entry.name}${suffix}`);
      }

      if (visibleEntries.length === 0) {
        return textToolResult("(empty directory)", {
          path: displayPath,
          absolutePath,
          visibleEntries: 0,
          totalEntries: totalVisibleEntries,
          entryLimitReached: false,
        });
      }

      let output = visibleEntries.join("\n");
      if (entryLimitReached) {
        output += `\n\n(${limit} visible entries shown. Increase limit for more.)`;
      }

      return textToolResult(output, {
        path: displayPath,
        absolutePath,
        visibleEntries: visibleEntries.length,
        totalEntries: totalVisibleEntries,
        entryLimitReached,
      });
    },
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
