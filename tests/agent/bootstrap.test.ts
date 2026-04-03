import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildBootstrapPrompt, loadAgentBootstrapSnapshot } from "@/src/agent/bootstrap.js";

describe("agent bootstrap resolver", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("loads BOOTSTRAP.md only for main chat sessions", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-bootstrap-"));
    await writeFile(
      path.join(tempDir, "BOOTSTRAP.md"),
      "# BOOTSTRAP.md\n\nAsk what to call the user.\n",
      "utf-8",
    );

    const chatMain = loadAgentBootstrapSnapshot({
      sessionPurpose: "chat",
      agentKind: "main",
      workspaceDir: tempDir,
    });
    const taskMain = loadAgentBootstrapSnapshot({
      sessionPurpose: "task",
      agentKind: "main",
      workspaceDir: tempDir,
    });
    const chatSub = loadAgentBootstrapSnapshot({
      sessionPurpose: "chat",
      agentKind: "sub",
      workspaceDir: tempDir,
    });

    expect(chatMain?.path).toBe(path.join(tempDir, "BOOTSTRAP.md"));
    expect(chatMain?.prompt).toContain("<bootstrap_file>");
    expect(chatMain?.prompt).toContain("Ask what to call the user.");
    expect(taskMain).toBeNull();
    expect(chatSub).toBeNull();
  });

  test("renders a stable bootstrap prompt block", () => {
    const prompt = buildBootstrapPrompt({
      path: "/tmp/ws/BOOTSTRAP.md",
      content: "Ask what to call the user.\nAsk what the assistant should be called.",
    });

    expect(prompt).toContain("<bootstrap_file>");
    expect(prompt).toContain("<path>/tmp/ws/BOOTSTRAP.md</path>");
    expect(prompt).toContain("Ask what to call the user.");
    expect(prompt).toContain("Ask what the assistant should be called.");
  });
});
