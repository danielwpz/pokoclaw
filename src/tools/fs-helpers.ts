import { readdir } from "node:fs/promises";
import path from "node:path";

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

const DEFAULT_SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export async function walkDirectory(options: WalkDirectoryOptions): Promise<void> {
  const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const skipDirectoryNames = new Set(options.skipDirectoryNames ?? []);
  const queue: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: options.rootPath, relativePath: "" },
  ];
  let visitedEntries = 0;

  while (queue.length > 0 && visitedEntries < maxEntries) {
    const current = queue.shift();
    if (current == null) {
      break;
    }

    const entries = await readdir(current.absolutePath, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );

    for (const dirent of entries) {
      if (visitedEntries >= maxEntries) {
        return;
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
        return;
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

  if (path.matchesGlob(normalizedRelativePath, normalizedPattern)) {
    return true;
  }

  if (!normalizedPattern.includes("/")) {
    return path.matchesGlob(baseName, normalizedPattern);
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
