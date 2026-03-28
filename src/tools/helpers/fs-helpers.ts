import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("tools/fs-helpers");

export interface WalkEntry {
  absolutePath: string;
  relativePath: string;
  name: string;
  kind: "file" | "directory";
}

export interface WalkDirectoryOptions {
  rootPath: string;
  maxEntries?: number;
  skipDirectoryNames?: string[];
  onEntry: (entry: WalkEntry) => Promise<"continue" | "skip" | "stop" | undefined>;
}

export interface WalkWarning {
  absolutePath: string;
  relativePath: string;
  errorCode: string | null;
  errorMessage: string;
}

export interface WalkDirectoryResult {
  warnings: WalkWarning[];
}

const DEFAULT_SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export async function walkDirectory(options: WalkDirectoryOptions): Promise<WalkDirectoryResult> {
  const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const skipDirectoryNames = new Set(options.skipDirectoryNames ?? []);
  const queue: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: options.rootPath, relativePath: "" },
  ];
  let visitedEntries = 0;
  const warnings: WalkWarning[] = [];

  while (queue.length > 0 && visitedEntries < maxEntries) {
    const current = queue.shift();
    if (current == null) {
      break;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (isSkippableReadDirectoryError(error)) {
        if (current.relativePath.length === 0) {
          throw error;
        }

        const warning: WalkWarning = {
          absolutePath: current.absolutePath,
          relativePath: current.relativePath,
          errorCode: getErrorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        warnings.push(warning);
        logger.debug("skipping unreadable directory during recursive walk", {
          path: current.absolutePath,
          relativePath: current.relativePath,
          errorCode: warning.errorCode,
          errorMessage: warning.errorMessage,
        });
        continue;
      }
      throw error;
    }
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );

    for (const dirent of entries) {
      if (visitedEntries >= maxEntries) {
        return { warnings };
      }

      const relativePath =
        current.relativePath.length === 0
          ? dirent.name
          : path.join(current.relativePath, dirent.name);
      const absolutePath = path.join(current.absolutePath, dirent.name);
      const isDirectory = dirent.isDirectory();
      const entry: WalkEntry = {
        absolutePath,
        relativePath,
        name: dirent.name,
        kind: isDirectory ? "directory" : "file",
      };

      visitedEntries += 1;
      const decision = await options.onEntry(entry);
      if (decision === "stop") {
        return { warnings };
      }

      if (
        isDirectory &&
        decision !== "skip" &&
        !skipDirectoryNames.has(dirent.name) &&
        !DEFAULT_SKIPPED_DIRECTORY_NAMES.has(dirent.name)
      ) {
        queue.push({ absolutePath, relativePath });
      }
    }
  }

  return { warnings };
}

function isSkippableReadDirectoryError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EACCES" || code === "ENOENT";
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error == null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function toDisplayRelativePath(rootPath: string, absolutePath: string): string {
  const relativePath = path.relative(rootPath, absolutePath);
  if (relativePath.length === 0) {
    return ".";
  }

  return toPosixPath(relativePath);
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function matchesFindPattern(
  pattern: string,
  relativePath: string,
  baseName: string,
): boolean {
  const normalizedPattern = toPosixPath(pattern);
  const normalizedRelativePath = toPosixPath(relativePath);
  const regex = compileGlobPattern(normalizedPattern);

  if (regex.test(normalizedRelativePath)) {
    return true;
  }

  if (!normalizedPattern.includes("/")) {
    return regex.test(baseName);
  }

  return false;
}

export function compileSearchPattern(
  pattern: string,
  options?: { literal?: boolean; ignoreCase?: boolean },
): RegExp {
  const flags = options?.ignoreCase ? "i" : "";
  if (options?.literal) {
    return new RegExp(escapeRegExp(pattern), flags);
  }

  return new RegExp(pattern, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileGlobPattern(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    const next = pattern[index + 1];
    if (current == null) {
      continue;
    }

    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (current === "*") {
      source += "[^/]*";
      continue;
    }

    if (current === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(current);
  }

  return new RegExp(`^${source}$`);
}
