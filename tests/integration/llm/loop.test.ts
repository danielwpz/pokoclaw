import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
import { SecurityService } from "@/src/security/service.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import { createReadTool } from "@/src/tools/read.js";
import {
  createIntegrationLlmFixture,
  type IntegrationLlmFixture,
  seedConversationFixture,
} from "@/tests/integration/llm/helpers/fixture.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("real llm loop integration", () => {
  let fixture: IntegrationLlmFixture;
  let handle: TestDatabaseHandle | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    fixture = await createIntegrationLlmFixture();
  });

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

  afterAll(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
    await fixture.cleanup();
  });

  test("runs the single-session loop against a real model", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle.storage.sqlite);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-23T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_1",
      seq: 1,
      role: "user",
      payloadJson: JSON.stringify({
        content: "Reply with the token POKECLAW_LOOP_OK and nothing else.",
      }),
      createdAt: new Date("2026-03-23T00:00:01.000Z"),
    });

    const toolRegistry = new ToolRegistry();
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: fixture.models,
      tools: toolRegistry,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: new PiAgentModelRunner(new PiBridge(), toolRegistry),
      storage: handle.storage.db,
      securityConfig: fixture.config.security,
      compaction: fixture.config.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const storedMessages = messagesRepo.listBySession("sess_1");
    expect(storedMessages).toHaveLength(2);
    expect(result.toolExecutions).toBe(0);
    expect(result.events.some((event) => event.type === "assistant_message_started")).toBe(true);
    expect(result.events.some((event) => event.type === "assistant_message_completed")).toBe(true);
    expect(result.events.at(-1)?.type).toBe("run_completed");

    const assistantPayload = JSON.parse(storedMessages[1]?.payloadJson ?? "{}");
    const assistantText = Array.isArray(assistantPayload.content)
      ? assistantPayload.content
          .filter((block: { type?: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("")
      : "";

    expect(assistantText).toContain("POKECLAW_LOOP_OK");
    expect(storedMessages[1]?.stopReason).toBe("stop");
    expect((storedMessages[1]?.tokenTotal ?? 0) > 0).toBe(true);
  }, 30_000);

  test("steers a new inbound message into the next turn after the current tool batch finishes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle.storage.sqlite);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    const cancel = new SessionRunAbortRegistry();
    sessionsRepo.create({
      id: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      purpose: "chat",
      createdAt: new Date("2026-03-23T00:00:00.000Z"),
    });

    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "pause_for_steer",
        description:
          "Pauses briefly, then returns READY. Use this when the user explicitly asks you to call this tool before answering.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
        async execute() {
          await delay(250);
          return textToolResult("READY");
        },
      }),
    );

    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: fixture.models,
      tools,
      cancel,
      modelRunner: new PiAgentModelRunner(new PiBridge(), tools),
      storage: handle.storage.db,
      securityConfig: fixture.config.security,
      compaction: fixture.config.compaction,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const runPromise = ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: [
        "Do the following exactly:",
        "1. Call the tool pause_for_steer exactly once before answering.",
        "2. After the tool returns, ignore every earlier user message in this conversation.",
        "3. Reply with only the token that appears after FINAL_TOKEN: in the newest user message.",
        "4. Do not answer before using the tool.",
      ].join("\n"),
    });

    await delay(50);

    const steerResult = await ingress.submitMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "FINAL_TOKEN: POKECLAW_STEER_OK",
    });

    expect(steerResult).toEqual({ status: "steered" });

    const result = await runPromise;
    expect(result.status).toBe("started");

    const storedMessages = messagesRepo.listBySession("sess_1");
    expect(storedMessages.length).toBeGreaterThanOrEqual(5);
    expect(storedMessages[2]?.role).toBe("tool");
    expect(JSON.parse(storedMessages[3]?.payloadJson ?? "{}")).toEqual({
      content: "FINAL_TOKEN: POKECLAW_STEER_OK",
    });

    // Keep this strict. The point of the integration test is not just that the
    // steer message is stored, but that the real model actually treats it as
    // the next-turn user instruction after the tool batch completes.
    const assistantPayload = JSON.parse(storedMessages.at(-1)?.payloadJson ?? "{}");
    const assistantText = Array.isArray(assistantPayload.content)
      ? assistantPayload.content
          .filter((block: { type?: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("")
      : "";

    expect(assistantText).toContain("POKECLAW_STEER_OK");
  }, 45_000);

  test("loads a repo-local skill, reads its SKILL.md, and answers with the skill's commit rules", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationFixture(handle.storage.sqlite);

    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-it-skill-repo-"));
    tempDirs.push(repoRoot);
    const workdir = path.join(repoRoot, "packages", "app");
    const skillDir = path.join(repoRoot, ".claude", "skills", "commit-rules");
    const skillPath = path.join(skillDir, "SKILL.md");

    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await mkdir(workdir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillPath,
      [
        "---",
        "name: commit-rules",
        "description: Read this skill when you need to commit code.",
        "---",
        "",
        "When you are about to commit code in this repository:",
        "1. Run build before committing.",
        "2. Run lint before committing.",
        "3. The commit message must be exactly one line.",
        "4. Do not use a multi-line commit message.",
        "",
      ].join("\n"),
      "utf8",
    );

    handle.storage.sqlite.exec(`
      INSERT INTO agents (id, conversation_id, kind, workdir, created_at)
      VALUES ('agent_main', 'conv_1', 'main', '${escapeSqlLiteral(workdir)}', '2026-03-23T00:00:00.000Z');
    `);

    const sessionsRepo = new SessionsRepo(handle.storage.db);
    const messagesRepo = new MessagesRepo(handle.storage.db);
    sessionsRepo.create({
      id: "sess_skill",
      conversationId: "conv_1",
      branchId: "branch_1",
      ownerAgentId: "agent_main",
      purpose: "chat",
      createdAt: new Date("2026-03-23T00:00:00.000Z"),
    });
    messagesRepo.append({
      id: "msg_user",
      sessionId: "sess_skill",
      seq: 1,
      role: "user",
      payloadJson: JSON.stringify({
        content:
          "I am about to commit code. What are this repository's commit requirements? Keep it brief.",
      }),
      createdAt: new Date("2026-03-23T00:00:01.000Z"),
    });

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_main",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${repoRoot}/**` }],
    });

    const toolRegistry = new ToolRegistry([createReadTool()]);
    const loop = new AgentLoop({
      sessions: new AgentSessionService(sessionsRepo, messagesRepo),
      messages: messagesRepo,
      models: fixture.models,
      tools: toolRegistry,
      cancel: new SessionRunAbortRegistry(),
      modelRunner: new PiAgentModelRunner(new PiBridge(), toolRegistry),
      storage: handle.storage.db,
      securityConfig: fixture.config.security,
      compaction: fixture.config.compaction,
    });

    const result = await loop.run({ sessionId: "sess_skill", scenario: "chat" });

    const storedMessages = messagesRepo.listBySession("sess_skill");
    expect(result.toolExecutions).toBeGreaterThanOrEqual(1);

    const toolRows = storedMessages.filter((message) => message.role === "tool");
    expect(toolRows.length).toBeGreaterThanOrEqual(1);

    const readResult = toolRows.find((message) => {
      const payload = JSON.parse(message.payloadJson) as {
        toolName?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = Array.isArray(payload.content)
        ? payload.content
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text ?? "")
            .join("\n")
        : "";
      return payload.toolName === "read" && text.includes("Run build before committing.");
    });

    expect(readResult).toBeDefined();
    expect(readResult?.payloadJson).toContain(skillPath);

    const assistantPayload = JSON.parse(storedMessages.at(-1)?.payloadJson ?? "{}");
    const assistantText = Array.isArray(assistantPayload.content)
      ? assistantPayload.content
          .filter((block: { type?: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("")
      : "";
    const normalizedAssistantText = assistantText.toLowerCase();

    expect(normalizedAssistantText).toContain("build");
    expect(normalizedAssistantText).toContain("lint");
    expect(normalizedAssistantText).toMatch(/one[- ]line|single[- ]line/);
    expect(normalizedAssistantText).toMatch(/multi-line/);
    expect(storedMessages.at(-1)?.stopReason).toBe("stop");
  }, 45_000);
});

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
