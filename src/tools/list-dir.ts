import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createFilesystemAccessController } from "@/src/tools/helpers/common.js";

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 25;
const DEFAULT_DEPTH = 2;
const INDENTATION_SPACES = 2;

export const LIST_DIR_TOOL_SCHEMA = Type.Object(
  {
    dir_path: Type.String({
      description: "Absolute path to the directory to list.",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_OFFSET,
        description: "The entry number to start listing from. Must be 1 or greater.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_LIMIT,
        description: "The maximum number of entries to return.",
      }),
    ),
    depth: Type.Optional(
      Type.Integer({
        minimum: 1,
        default: DEFAULT_DEPTH,
        description: "The maximum directory depth to traverse. Must be 1 or greater.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ListDirToolArgs = Static<typeof LIST_DIR_TOOL_SCHEMA>;

export interface ListDirToolDetails {
  dirPath: string;
  absolutePath: string;
  offset: number;
  limit: number;
  depth: number;
  returnedEntries: number;
  hasMore: boolean;
}

type DirEntryKind = "directory" | "file" | "symlink" | "other";

export function createListDirTool() {
  return defineTool({
    name: "list_dir",
    description:
      "Lists entries in a local directory with 1-indexed entry numbers and simple type labels.",
    inputSchema: LIST_DIR_TOOL_SCHEMA,
    async execute(context, args) {
      if (!path.isAbsolute(args.dir_path)) {
        throw toolRecoverableError("dir_path must be an absolute path", {
          code: "dir_path_must_be_absolute",
          dirPath: args.dir_path,
        });
      }

      const access = createFilesystemAccessController(context);
      const absolutePath = access.require({ kind: "fs.read", targetPath: args.dir_path });
      const offset = args.offset ?? DEFAULT_OFFSET;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const depth = args.depth ?? DEFAULT_DEPTH;

      let rootStats: Awaited<ReturnType<typeof stat>>;
      try {
        rootStats = await stat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw toolRecoverableError(`Path not found: ${absolutePath}`, {
            code: "path_not_found",
            path: absolutePath,
          });
        }
        throw error;
      }

      if (!rootStats.isDirectory()) {
        throw toolRecoverableError(`Not a directory: ${absolutePath}`, {
          code: "not_a_directory",
          path: absolutePath,
        });
      }

      const result = await listDirectorySlice({
        rootPath: absolutePath,
        depth,
        offset,
        limit,
        access,
      });

      const lines = [`Absolute path: ${absolutePath}`, ...result.entries];
      return textToolResult(lines.join("\n"), {
        dirPath: args.dir_path,
        absolutePath,
        offset,
        limit,
        depth,
        returnedEntries: result.entries.length,
        hasMore: result.hasMore,
      });
    },
  });
}

async function listDirectorySlice(input: {
  rootPath: string;
  depth: number;
  offset: number;
  limit: number;
  access: ReturnType<typeof createFilesystemAccessController>;
}): Promise<{ entries: string[]; hasMore: boolean }> {
  let visibleEntryCount = 0;
  let hasMore = false;
  const entries: string[] = [];
  const endOffset = input.offset + input.limit - 1;

  const walk = async (
    currentDirectory: string,
    currentDepth: number,
  ): Promise<"continue" | "stop"> => {
    let dirEntries: Dirent<string>[];
    try {
      dirEntries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      throw toolRecoverableError(
        `Failed to read directory: ${path.relative(input.rootPath, currentDirectory) || "."}`,
        {
          code: "directory_read_failed",
          path: currentDirectory,
          rawMessage: error instanceof Error ? error.message : String(error),
        },
      );
    }

    dirEntries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );

    for (const dirent of dirEntries) {
      const absolutePath = path.join(currentDirectory, dirent.name);
      const decision = input.access.check({ kind: "fs.read", targetPath: absolutePath });
      if (decision.access.result === "deny") {
        continue;
      }

      visibleEntryCount += 1;
      if (visibleEntryCount >= input.offset && visibleEntryCount <= endOffset) {
        entries.push(formatEntryLine(dirent.name, currentDepth, getDirEntryKind(dirent)));
      } else if (visibleEntryCount > endOffset) {
        hasMore = true;
        return "stop";
      }

      if (dirent.isDirectory() && input.depth > currentDepth + 1) {
        const nested = await walk(absolutePath, currentDepth + 1);
        if (nested === "stop") {
          return "stop";
        }
      }
    }

    return "continue";
  };

  await walk(input.rootPath, 0);

  if (visibleEntryCount > 0 && input.offset > visibleEntryCount) {
    throw toolRecoverableError("offset exceeds directory entry count", {
      code: "offset_exceeds_directory_entry_count",
      offset: input.offset,
      totalVisibleEntries: visibleEntryCount,
      path: input.rootPath,
    });
  }

  if (hasMore) {
    entries.push(`More than ${input.limit} entries found`);
  }

  return { entries, hasMore };
}

function getDirEntryKind(dirent: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DirEntryKind {
  if (dirent.isSymbolicLink()) {
    return "symlink";
  }
  if (dirent.isDirectory()) {
    return "directory";
  }
  if (dirent.isFile()) {
    return "file";
  }
  return "other";
}

function formatEntryLine(name: string, depth: number, kind: DirEntryKind): string {
  const indent = " ".repeat(depth * INDENTATION_SPACES);
  const suffix =
    kind === "directory" ? "/" : kind === "symlink" ? "@" : kind === "other" ? "?" : "";
  return `${indent}${name}${suffix}`;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
