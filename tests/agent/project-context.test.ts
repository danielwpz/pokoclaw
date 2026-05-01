import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildProjectContextPrompt, loadAgentProjectContext } from "@/src/agent/project-context.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";

describe("agent project context", () => {
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

  test("loads repo-root AGENTS and CLAUDE files plus nested workdir CLAUDE", async () => {
    const repoRoot = await createTempDir("pokoclaw-project-context-");
    const workdir = path.join(repoRoot, "packages", "web");
    await mkdir(workdir, { recursive: true });
    await writeFile(path.join(repoRoot, ".git"), "gitdir: .git/worktrees/test\n", "utf8");
    await writeFile(path.join(repoRoot, "AGENTS.md"), "Root agent guidance", "utf8");
    await writeFile(path.join(repoRoot, "CLAUDE.md"), "Root Claude guidance", "utf8");
    await writeFile(path.join(workdir, "CLAUDE.md"), "Package Claude guidance", "utf8");

    const snapshot = loadAgentProjectContext({
      workdir,
      config: DEFAULT_CONFIG.projectContext,
    });

    expect(snapshot.entries.map((entry) => [entry.source, path.basename(entry.path)])).toEqual([
      ["repo_root", "AGENTS.md"],
      ["repo_root", "CLAUDE.md"],
      ["workdir", "CLAUDE.md"],
    ]);
    expect(snapshot.prompt).toContain("<project_context>");
    expect(snapshot.prompt).toContain("<source>repo_root</source>");
    expect(snapshot.prompt).toContain("<source>workdir</source>");
    expect(snapshot.prompt).toContain("Root agent guidance");
    expect(snapshot.prompt).toContain("Package Claude guidance");
  });

  test("returns empty context when disabled or no context files exist", async () => {
    const dir = await createTempDir("pokoclaw-project-context-miss-");

    expect(
      loadAgentProjectContext({
        workdir: dir,
        config: DEFAULT_CONFIG.projectContext,
      }).entries,
    ).toEqual([]);

    await writeFile(path.join(dir, ".git"), "gitdir: .git/worktrees/test\n", "utf8");
    await writeFile(path.join(dir, "AGENTS.md"), "Root agent guidance", "utf8");

    expect(
      loadAgentProjectContext({
        workdir: dir,
        config: {
          ...DEFAULT_CONFIG.projectContext,
          enabled: false,
        },
      }).entries,
    ).toEqual([]);
  });

  test("falls back to workdir context files when not inside a git repo", async () => {
    // Covers non-code project layouts (Obsidian vaults, document-only folders)
    // where CLAUDE.md / AGENTS.md sit beside the working files but no .git
    // marker exists anywhere up the tree.
    const workdir = await createTempDir("pokoclaw-project-context-nogit-");
    await writeFile(path.join(workdir, "CLAUDE.md"), "Vault project rules", "utf8");
    await writeFile(path.join(workdir, "AGENTS.md"), "Vault agent guidance", "utf8");

    const snapshot = loadAgentProjectContext({
      workdir,
      config: DEFAULT_CONFIG.projectContext,
    });

    expect(snapshot.entries.map((entry) => [entry.source, path.basename(entry.path)])).toEqual([
      ["workdir", "AGENTS.md"],
      ["workdir", "CLAUDE.md"],
    ]);
    expect(snapshot.prompt).toContain("Vault project rules");
    expect(snapshot.prompt).toContain("Vault agent guidance");
  });

  test("truncates large files with a clear head and tail marker", async () => {
    const repoRoot = await createTempDir("pokoclaw-project-context-truncate-");
    await writeFile(path.join(repoRoot, ".git"), "gitdir: .git/worktrees/test\n", "utf8");
    await writeFile(
      path.join(repoRoot, "AGENTS.md"),
      `HEAD-${"a".repeat(1200)}${"b".repeat(1200)}-TAIL`,
      "utf8",
    );

    const snapshot = loadAgentProjectContext({
      workdir: repoRoot,
      config: {
        ...DEFAULT_CONFIG.projectContext,
        maxBytes: 400,
      },
    });

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.truncated).toBe(true);
    expect(snapshot.prompt).toContain("HEAD-");
    expect(snapshot.prompt).toContain("-TAIL");
    expect(snapshot.prompt).toContain("truncated at 400 bytes");
  });

  test.runIf(process.platform !== "win32")(
    "skips symlinked project files that resolve outside the repo",
    async () => {
      const root = await createTempDir("pokoclaw-project-context-escape-");
      const repoRoot = path.join(root, "repo");
      const outside = path.join(root, "outside");
      await mkdir(repoRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(repoRoot, ".git"), "gitdir: .git/worktrees/test\n", "utf8");
      await writeFile(path.join(outside, "AGENTS.md"), "outside guidance", "utf8");
      await symlink(path.join(outside, "AGENTS.md"), path.join(repoRoot, "AGENTS.md"));

      const snapshot = loadAgentProjectContext({
        workdir: repoRoot,
        config: DEFAULT_CONFIG.projectContext,
      });

      expect(snapshot.entries).toEqual([]);
      expect(snapshot.warnings.map((warning) => warning.reason)).toEqual([
        "project_context_path_escape",
      ]);
      expect(snapshot.prompt).not.toContain("outside guidance");
    },
  );

  test("buildProjectContextPrompt escapes injected file content", () => {
    const prompt = buildProjectContextPrompt([
      {
        source: "repo_root",
        path: "/repo/AGENTS.md",
        content: '<tag> & "quote"',
        truncated: false,
        originalBytes: 15,
        injectedBytes: 15,
      },
    ]);

    expect(prompt).toContain("&lt;tag&gt; &amp; &quot;quote&quot;");
  });

  async function createTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
});
