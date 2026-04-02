import fs from "node:fs";
import path from "node:path";

export const MAX_GIT_ROOT_PARENT_STEPS = 3;

export function findRepoRootFromGit(workdir?: string | null): string | null {
  const trimmedWorkdir = workdir?.trim();
  if (!trimmedWorkdir) {
    return null;
  }

  let currentDir = path.resolve(trimmedWorkdir);
  for (let step = 0; step <= MAX_GIT_ROOT_PARENT_STEPS; step += 1) {
    const gitMarker = path.join(currentDir, ".git");
    if (isExistingDirectory(gitMarker) || isExistingFile(gitMarker)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

function isExistingDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}
