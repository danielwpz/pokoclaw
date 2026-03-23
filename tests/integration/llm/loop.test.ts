import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionRunAbortRegistry } from "@/src/agent/cancel.js";
import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { createTestLogger } from "@/src/shared/logger.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { ToolRegistry } from "@/src/tools/registry.js";
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

  beforeAll(async () => {
    fixture = await createIntegrationLlmFixture();
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
      logger: createTestLogger(
        { level: "info", useColors: false },
        { subsystem: "llm-loop-integration-test" },
      ),
      compaction: fixture.config.compaction,
    });

    const result = await loop.run({ sessionId: "sess_1", scenario: "chat" });

    const storedMessages = messagesRepo.listBySession("sess_1");
    expect(storedMessages).toHaveLength(2);
    expect(result.toolExecutions).toBe(0);
    expect(result.events.some((event) => event.type === "assistant_message_delta")).toBe(true);
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
});
