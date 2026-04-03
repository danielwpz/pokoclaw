import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  buildPrivateWorkspaceMemoryPath,
  buildSubagentMemoryPath,
  buildWorkspaceBootstrapPath,
  buildWorkspaceSharedMemoryPath,
  buildWorkspaceSoulPath,
  ensureAgentMemoryFiles,
  resolveAgentMemoryFileDescriptors,
} from "@/src/memory/files.js";

describe("memory file helpers", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("builds workspace-level soul and shared memory paths", () => {
    const workspaceDir = "/tmp/pokeclaw-workspace";

    expect(buildWorkspaceSoulPath(workspaceDir)).toBe("/tmp/pokeclaw-workspace/SOUL.md");
    expect(buildWorkspaceSharedMemoryPath(workspaceDir)).toBe("/tmp/pokeclaw-workspace/MEMORY.md");
  });

  test("builds private workspace and subagent memory paths", () => {
    expect(buildPrivateWorkspaceMemoryPath("/tmp/private")).toBe("/tmp/private/MEMORY.md");
    expect(buildSubagentMemoryPath("abc-123")).toContain(
      `${path.sep}subagents${path.sep}abc123${path.sep}MEMORY.md`,
    );
  });

  test("resolves main-agent descriptors to soul plus shared memory", () => {
    const descriptors = resolveAgentMemoryFileDescriptors({
      agentKind: "main",
      workspaceDir: "/tmp/ws",
    });

    expect(descriptors).toEqual([
      {
        layer: "soul",
        path: "/tmp/ws/SOUL.md",
        purpose: "Identity, tone, boundaries, and stable user profile.",
      },
      {
        layer: "shared",
        path: "/tmp/ws/MEMORY.md",
        purpose: "Long-lived shared memory and the main agent's durable memory.",
      },
    ]);
  });

  test("does not resolve memory descriptors for ownerless sessions", () => {
    const descriptors = resolveAgentMemoryFileDescriptors({
      agentKind: null,
      workspaceDir: "/tmp/ws",
    });

    expect(descriptors).toEqual([]);
  });

  test("resolves subagent descriptors to soul, shared, and private memory", () => {
    const descriptors = resolveAgentMemoryFileDescriptors({
      agentKind: "sub",
      workspaceDir: "/tmp/ws",
      privateWorkspaceDir: "/tmp/ws/subagents/abcd1234",
    });

    expect(descriptors).toEqual([
      {
        layer: "soul",
        path: "/tmp/ws/SOUL.md",
        purpose: "Identity, tone, boundaries, and stable user profile.",
      },
      {
        layer: "shared",
        path: "/tmp/ws/MEMORY.md",
        purpose: "Long-lived shared memory and the main agent's durable memory.",
      },
      {
        layer: "private",
        path: "/tmp/ws/subagents/abcd1234/MEMORY.md",
        purpose: "This subagent's private durable memory for local constraints and lessons.",
      },
    ]);
  });

  test("seeds main-agent soul and shared memory scaffolds when missing", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-memory-files-"));

    ensureAgentMemoryFiles({
      agentKind: "main",
      workspaceDir: tempDir,
    });

    const soul = await readFile(path.join(tempDir, "SOUL.md"), "utf-8");
    const shared = await readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    const bootstrap = await readFile(path.join(tempDir, "BOOTSTRAP.md"), "utf-8");

    expect(soul).toContain("# Identity");
    expect(soul).toContain("# User Profile");
    expect(shared).toContain("# Preferences");
    expect(shared).toContain("# Projects");
    expect(bootstrap).toContain("what you should call the user");
    expect(bootstrap).toContain("what the user wants to call you");
  });

  test("seeds subagent private memory scaffold when missing", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-memory-files-"));
    const privateWorkspaceDir = path.join(tempDir, "subagents", "abcd1234");

    ensureAgentMemoryFiles({
      agentKind: "sub",
      workspaceDir: tempDir,
      privateWorkspaceDir,
    });

    const privateMemory = await readFile(path.join(privateWorkspaceDir, "MEMORY.md"), "utf-8");
    expect(privateMemory).toContain("# Scope");
    expect(privateMemory).toContain("# Durable Local Facts");
  });

  test("does not overwrite existing memory content when scaffolding", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-memory-files-"));
    const soulPath = path.join(tempDir, "SOUL.md");
    await writeFile(soulPath, "# Identity\n- Assistant name: Rowan\n", "utf-8");

    ensureAgentMemoryFiles({
      agentKind: "main",
      workspaceDir: tempDir,
    });

    const soul = await readFile(soulPath, "utf-8");
    expect(soul).toBe("# Identity\n- Assistant name: Rowan\n");
  });

  test("does not create BOOTSTRAP.md when SOUL.md already exists", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-memory-files-"));
    await writeFile(
      path.join(tempDir, "SOUL.md"),
      "# Identity\n- Assistant name: Rowan\n\n# User Profile\n- Preferred name: Mina\n",
      "utf-8",
    );

    ensureAgentMemoryFiles({
      agentKind: "main",
      workspaceDir: tempDir,
    });

    await expect(readFile(buildWorkspaceBootstrapPath(tempDir), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
