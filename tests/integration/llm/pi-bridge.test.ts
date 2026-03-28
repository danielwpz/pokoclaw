import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PiBridge } from "@/src/agent/llm/pi-bridge.js";
import type { Message } from "@/src/storage/schema/types.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  createIntegrationLlmFixture,
  createStoredAssistantMessage,
  createStoredToolResultMessage,
  createStoredUserMessage,
  type IntegrationLlmFixture,
} from "@/tests/integration/llm/helpers/fixture.js";

describe("real llm pi bridge integration", () => {
  let fixture: IntegrationLlmFixture;

  beforeAll(async () => {
    fixture = await createIntegrationLlmFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  test("streams a real assistant reply", async () => {
    const bridge = new PiBridge();
    const model = fixture.models.getRequiredScenarioModel("chat");
    const deltas: string[] = [];

    const result = await bridge.streamTurn({
      model,
      compactSummary: null,
      messages: [
        createStoredUserMessage({
          sessionId: "sess_stream",
          id: "msg_user_1",
          seq: 1,
          content: "Reply with the token POKECLAW_STREAM_OK and nothing else.",
          createdAt: "2026-03-23T00:00:01.000Z",
        }),
      ],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
      onTextDelta(event) {
        deltas.push(event.delta);
      },
    });

    expect(deltas.length).toBeGreaterThan(0);
    expect(collectAssistantText(result.content)).toContain("POKECLAW_STREAM_OK");
    expect(result.stopReason).toBe("stop");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.modelApi).toBe(resolveExpectedPiApi(model));
  }, 30_000);

  test("completes a real non-streaming reply", async () => {
    const bridge = new PiBridge();
    const model = fixture.models.getRequiredScenarioModel("chat");

    const result = await bridge.completeTurn({
      model,
      compactSummary: null,
      messages: [
        createStoredUserMessage({
          sessionId: "sess_complete",
          id: "msg_user_1",
          seq: 1,
          content: "Reply with the token POKECLAW_COMPLETE_OK and nothing else.",
          createdAt: "2026-03-23T00:00:01.000Z",
        }),
      ],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(collectAssistantText(result.content)).toContain("POKECLAW_COMPLETE_OK");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  }, 30_000);

  test("replays stored assistant history into a real follow-up call", async () => {
    const bridge = new PiBridge();
    const model = fixture.models.getRequiredScenarioModel("chat");
    const messages: Message[] = [
      createStoredUserMessage({
        sessionId: "sess_history",
        id: "msg_user_1",
        seq: 1,
        content: "Remember the code phrase ORBIT-NEEDLE.",
        createdAt: "2026-03-23T00:00:01.000Z",
      }),
      createStoredAssistantMessage({
        sessionId: "sess_history",
        id: "msg_assistant_1",
        seq: 2,
        createdAt: "2026-03-23T00:00:02.000Z",
        provider: model.provider.id,
        model: model.upstreamId,
        modelApi: model.provider.api,
        stopReason: "stop",
        content: [{ type: "text", text: "ORBIT-NEEDLE" }],
      }),
      createStoredUserMessage({
        sessionId: "sess_history",
        id: "msg_user_2",
        seq: 3,
        content: "What was the code phrase? Include ORBIT-NEEDLE in your answer.",
        createdAt: "2026-03-23T00:00:03.000Z",
      }),
    ];

    const result = await bridge.completeTurn({
      model,
      compactSummary: null,
      messages,
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(normalizeComparableText(collectAssistantText(result.content))).toContain("ORBIT-NEEDLE");
  }, 30_000);

  test("replays stored tool results into a real follow-up call", async () => {
    const bridge = new PiBridge();
    const model = fixture.models.getRequiredScenarioModel("chat");
    const messages: Message[] = [
      createStoredUserMessage({
        sessionId: "sess_tool_history",
        id: "msg_user_1",
        seq: 1,
        content: "Use the memory tool to fetch the anchor token.",
        createdAt: "2026-03-23T00:00:01.000Z",
      }),
      createStoredAssistantMessage({
        sessionId: "sess_tool_history",
        id: "msg_assistant_1",
        seq: 2,
        createdAt: "2026-03-23T00:00:02.000Z",
        provider: model.provider.id,
        model: model.upstreamId,
        modelApi: model.provider.api,
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool_1",
            name: "memory_lookup",
            arguments: {},
          },
        ],
      }),
      createStoredToolResultMessage({
        sessionId: "sess_tool_history",
        id: "msg_tool_1",
        seq: 3,
        createdAt: "2026-03-23T00:00:03.000Z",
        toolCallId: "tool_1",
        toolName: "memory_lookup",
        content: [{ type: "text", text: "TOOL-ANCHOR-917" }],
      }),
      createStoredUserMessage({
        sessionId: "sess_tool_history",
        id: "msg_user_2",
        seq: 4,
        content: "Reply with the previous tool output and include TOOL-ANCHOR-917 in your answer.",
        createdAt: "2026-03-23T00:00:04.000Z",
      }),
    ];

    const result = await bridge.completeTurn({
      model,
      compactSummary: null,
      messages,
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(normalizeComparableText(collectAssistantText(result.content))).toContain(
      "TOOL-ANCHOR-917",
    );
  }, 30_000);
});

function collectAssistantText(
  content: Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }>,
): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function normalizeComparableText(value: string): string {
  return value.replaceAll(/\p{Pd}/gu, "-");
}

function resolveExpectedPiApi(model: {
  provider: { api: string };
  id: string;
  upstreamId: string;
}): string {
  if (model.provider.api !== "openai-responses") {
    return model.provider.api;
  }

  const normalizedIds = [model.id, model.upstreamId].map((value) => value.toLowerCase());
  const isGptFamily = normalizedIds.some((value) => value.includes("gpt"));
  return isGptFamily ? "openai-responses" : "openai-completions";
}
