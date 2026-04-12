import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { findRepoRootFromGit } from "@/src/shared/repo-root.js";
import { resolveRepoLocalSkillDirs } from "@/src/shared/repo-skill-roots.js";

describe("repo-local skill roots", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        rm(dir, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  test("resolves repo root and explicit repo-local skill directories from a nested workdir", async () => {
    const repoRoot = await createTempDir("pokoclaw-repo-skill-roots-");
    const nestedWorkdir = path.join(repoRoot, "packages", "web", "src");

    await mkdir(nestedWorkdir, { recursive: true });
    await writeFile(path.join(repoRoot, ".git"), "gitdir: .git/worktrees/test\n", "utf8");

    expect(findRepoRootFromGit(nestedWorkdir)).toBe(repoRoot);
    expect(resolveRepoLocalSkillDirs(nestedWorkdir)).toEqual({
      repoRoot,
      agentsSkillsDir: path.join(repoRoot, ".agents", "skills"),
      claudeSkillsDir: path.join(repoRoot, ".claude", "skills"),
    });
  });

  test("returns null when no git root is found within the search window", async () => {
    const baseDir = await createTempDir("pokoclaw-repo-skill-miss-");
    const deepWorkdir = path.join(baseDir, "a", "b", "c", "d", "e");

    await mkdir(deepWorkdir, { recursive: true });
    await mkdir(path.join(baseDir, ".git"), { recursive: true });

    expect(findRepoRootFromGit(deepWorkdir)).toBeNull();
    expect(resolveRepoLocalSkillDirs(deepWorkdir)).toBeNull();
  });

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});
