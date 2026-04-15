import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildMemoryCatalogPrompt,
  FilesystemAgentMemoryResolver,
  loadAgentMemoryCatalog,
} from "@/src/agent/memory.js";

describe("agent memory resolver", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("loads workspace soul and shared memory for main-agent runs", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-memory-"));
    await writeFile(path.join(tempDir, "SOUL.md"), "# SOUL\nUser is a founder in Shanghai.\n");
    await writeFile(path.join(tempDir, "MEMORY.md"), "# MEMORY\nPrefers concise updates.\n");

    const snapshot = loadAgentMemoryCatalog({
      agentKind: "main",
      workspaceDir: tempDir,
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.entries.map((entry) => entry.layer)).toEqual(["soul", "shared"]);
    expect(snapshot.prompt).toContain("<memory_files>");
    expect(snapshot.prompt).toContain("User is a founder in Shanghai.");
    expect(snapshot.prompt).toContain("Prefers concise updates.");
  });

  test("loads subagent private memory in addition to workspace memory", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-memory-"));
    const privateWorkspaceDir = path.join(tempDir, "subagents", "abcd1234");
    await mkdir(privateWorkspaceDir, { recursive: true });
    await writeFile(path.join(tempDir, "SOUL.md"), "Soul");
    await writeFile(path.join(tempDir, "MEMORY.md"), "Shared");
    await writeFile(path.join(privateWorkspaceDir, "MEMORY.md"), "Private");

    const snapshot = loadAgentMemoryCatalog({
      agentKind: "sub",
      workspaceDir: tempDir,
      privateWorkspaceDir,
    });

    expect(snapshot.entries.map((entry) => entry.layer)).toEqual(["soul", "shared", "private"]);
    expect(snapshot.prompt).toContain("<layer>private</layer>");
    expect(snapshot.prompt).toContain("Private");
  });

  test("ignores missing or empty memory files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-memory-"));
    await writeFile(path.join(tempDir, "SOUL.md"), "   \n");

    const snapshot = loadAgentMemoryCatalog({
      agentKind: "main",
      workspaceDir: tempDir,
    });

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.prompt).toBe("");
  });

  test("renders a stable memory prompt block", () => {
    const prompt = buildMemoryCatalogPrompt([
      {
        layer: "soul",
        path: "/tmp/ws/SOUL.md",
        purpose: "Identity, tone, boundaries, and stable user profile.",
        content: "Name: Pokoclaw\nUser: Founder",
      },
    ]);

    expect(prompt).toContain("<memory_files>");
    expect(prompt).toContain("<layer>soul</layer>");
    expect(prompt).toContain("<path>/tmp/ws/SOUL.md</path>");
    expect(prompt).toContain("Name: Pokoclaw");
    expect(prompt).toContain("User: Founder");
  });

  test("resolver seeds missing workspace memory files before reading them", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-memory-"));
    const resolver = new FilesystemAgentMemoryResolver();

    const snapshot = resolver.resolveForRun({
      agentKind: "main",
      workspaceDir: tempDir,
    });

    const soul = await readFile(path.join(tempDir, "SOUL.md"), "utf-8");
    const shared = await readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    const bootstrap = await readFile(path.join(tempDir, "BOOTSTRAP.md"), "utf-8");

    expect(snapshot.entries.map((entry) => entry.layer)).toEqual(["soul", "shared"]);
    expect(snapshot.prompt).toContain("# Identity");
    expect(snapshot.prompt).toContain("# Preferences");
    expect(soul).toContain("# User Profile");
    expect(shared).toContain("# Working Conventions");
    expect(bootstrap).toContain("Your first priority is to create a usable SOUL.md.");
    expect(bootstrap).toContain(
      "Do not mention BOOTSTRAP.md, SOUL.md, MEMORY.md, or other internal file mechanics to the user.",
    );
    expect(bootstrap).toContain(
      "Do not mix bootstrap questions and the final product-usage handoff into one overloaded reply unless the user explicitly asks for both at once.",
    );
    expect(bootstrap).toContain(
      "Before finishing bootstrap, proactively teach the user how to use Pokoclaw well.",
    );
    expect(bootstrap).toContain(
      "specialized, multi-step, long-running, or recurring work often belongs in a SubAgent.",
    );
    expect(bootstrap).toContain(
      "Help me create a SubAgent that fetches the latest financial news every day.",
    );
  });

  test("resolver seeds subagent private memory before reading it", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-memory-"));
    const privateWorkspaceDir = path.join(tempDir, "subagents", "abcd1234");
    const resolver = new FilesystemAgentMemoryResolver();

    const snapshot = resolver.resolveForRun({
      agentKind: "sub",
      workspaceDir: tempDir,
      privateWorkspaceDir,
    });

    const privateMemory = await readFile(path.join(privateWorkspaceDir, "MEMORY.md"), "utf-8");

    expect(snapshot.entries.map((entry) => entry.layer)).toEqual(["soul", "shared", "private"]);
    expect(snapshot.prompt).toContain("# Scope");
    expect(privateMemory).toContain("# Durable Local Facts");
  });
});
