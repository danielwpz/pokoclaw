import { readFile, stat, writeFile } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";

import { createFilesystemAccessController, formatDisplayPath } from "@/src/tools/common.js";
import { toolRecoverableError } from "@/src/tools/errors.js";
import { defineTool, textToolResult } from "@/src/tools/types.js";

export const EDIT_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String({
      description: "Absolute or relative path to the file to edit.",
    }),
    oldText: Type.String({
      minLength: 1,
      description: "Existing text to find in the file.",
    }),
    newText: Type.String({
      description: "Replacement text.",
    }),
    replaceAll: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Replace every occurrence instead of requiring a unique match. Defaults to false.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type EditToolArgs = Static<typeof EDIT_TOOL_SCHEMA>;

export interface EditToolDetails {
  path: string;
  absolutePath: string;
  replacements: number;
  matchMode: "exact" | "trimmed_lines";
}

export function createEditTool() {
  return defineTool({
    name: "edit",
    description:
      "Edit a file by replacing existing text with new text. Use replaceAll when the old text appears multiple times on purpose.",
    inputSchema: EDIT_TOOL_SCHEMA,
    async execute(context, args) {
      const access = createFilesystemAccessController(context);
      const [readDecision] = access.authorize([
        { kind: "fs.read", targetPath: args.path },
        { kind: "fs.write", targetPath: args.path },
      ]);
      const absolutePath = readDecision?.normalizedPath ?? args.path;
      const displayPath = formatDisplayPath(args.path, access.cwd);
      const replaceAll = args.replaceAll === true;

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

      const rawContent = await readFile(absolutePath, "utf8");
      const usesCrLf = rawContent.includes("\r\n");
      const normalizedContent = normalizeLineEndings(rawContent);
      const normalizedOldText = normalizeLineEndings(args.oldText);
      const normalizedNewText = normalizeLineEndings(args.newText);
      const match = findEditMatch(normalizedContent, normalizedOldText);

      if (match == null) {
        throw toolRecoverableError(
          `Could not find the requested text in ${displayPath}. The oldText must match existing content.`,
          {
            code: "old_text_not_found",
            path: absolutePath,
          },
        );
      }

      if (match.count > 1 && !replaceAll) {
        throw toolRecoverableError(
          `Found ${match.count} matches in ${displayPath}. Provide more context or set replaceAll=true.`,
          {
            code: "multiple_matches",
            path: absolutePath,
            occurrences: match.count,
          },
        );
      }

      const nextContent = replaceAll
        ? normalizedContent.split(match.fragment).join(normalizedNewText)
        : replaceFirst(normalizedContent, match.fragment, normalizedNewText);

      if (nextContent === normalizedContent) {
        throw toolRecoverableError(`No changes were made to ${displayPath}.`, {
          code: "no_changes",
          path: absolutePath,
        });
      }

      const finalContent = usesCrLf ? nextContent.replace(/\n/g, "\r\n") : nextContent;
      await writeFile(absolutePath, finalContent, "utf8");

      return textToolResult(`Edited ${displayPath}.`, {
        path: displayPath,
        absolutePath,
        replacements: replaceAll ? match.count : 1,
        matchMode: match.mode,
      });
    },
  });
}

interface EditMatch {
  fragment: string;
  count: number;
  mode: "exact" | "trimmed_lines";
}

function findEditMatch(content: string, oldText: string): EditMatch | null {
  if (content.includes(oldText)) {
    return {
      fragment: oldText,
      count: content.split(oldText).length - 1,
      mode: "exact",
    };
  }

  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) {
    return null;
  }

  const trimmedOldLines = oldLines.map((line) => line.trim());
  const contentLines = content.split("\n");
  const matches: string[] = [];

  for (let index = 0; index <= contentLines.length - trimmedOldLines.length; index += 1) {
    const windowLines = contentLines.slice(index, index + trimmedOldLines.length);
    if (windowLines.map((line) => line.trim()).join("\n") === trimmedOldLines.join("\n")) {
      matches.push(windowLines.join("\n"));
    }
  }

  if (matches.length === 0) {
    return null;
  }

  const firstMatch = matches[0];
  if (firstMatch == null) {
    return null;
  }

  return {
    fragment: firstMatch,
    count: matches.length,
    mode: "trimmed_lines",
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function replaceFirst(content: string, fragment: string, replacement: string): string {
  const index = content.indexOf(fragment);
  if (index === -1) {
    return content;
  }

  return content.slice(0, index) + replacement + content.slice(index + fragment.length);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
