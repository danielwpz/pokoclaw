import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import { PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { ToolRegistry } from "@/src/agent/tools/registry.js";
import type { Message } from "@/src/storage/schema/types.js";

const { completeSimpleMock, streamSimpleMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  streamSimpleMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    completeSimple: completeSimpleMock,
    streamSimple: streamSimpleMock,
  };
});

function createResolvedModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    id: "anthropic_main/claude-sonnet-4-5",
    providerId: "anthropic_main",
    upstreamId: "claude-sonnet-4-5-20250929",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    provider: {
      id: "anthropic_main",
      api: "anthropic-messages",
      apiKey: "secret",
    },
    ...overrides,
  };
}

function createStoredUserMessage(): Message {
  return {
    id: "msg_user",
    sessionId: "sess_1",
    seq: 1,
    role: "user",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({ content: "hello" }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: "2026-03-22T00:00:01.000Z",
  };
}

function createAssistantEventStream(events: AssistantMessageEvent[], result: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    async result() {
      return result;
    },
  };
}

describe("pi bridge", () => {
  afterEach(() => {
    completeSimpleMock.mockReset();
    streamSimpleMock.mockReset();
  });

  test("streams text deltas and returns a normalized assistant result", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "stop" as const,
      content: [{ type: "text" as const, text: "hello world" }],
      usage: {
        input: 10,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 13,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };
    streamSimpleMock.mockReturnValue(
      createAssistantEventStream(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "hello ",
            partial: finalMessage,
          },
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "world",
            partial: finalMessage,
          },
          {
            type: "done",
            reason: "stop",
            message: finalMessage,
          },
        ],
        finalMessage,
      ),
    );

    const deltas: Array<{ delta: string; accumulatedText: string }> = [];
    const bridge = new PiBridge();
    const result = await bridge.streamTurn({
      model: createResolvedModel(),
      compactSummary: "summary",
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry([
        {
          name: "bash",
          description: "Run a shell command",
          execute() {
            throw new Error("not used");
          },
        },
      ]),
      signal: new AbortController().signal,
      onTextDelta(event) {
        deltas.push(event);
      },
    });

    expect(deltas).toEqual([
      { delta: "hello ", accumulatedText: "hello " },
      { delta: "world", accumulatedText: "hello world" },
    ]);
    expect(result).toEqual({
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      content: [{ type: "text", text: "hello world" }],
      usage: {
        input: 10,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 13,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    });

    expect(streamSimpleMock).toHaveBeenCalledTimes(1);
    const [model, context, options] = streamSimpleMock.mock.calls[0] as [
      ResolvedModel,
      { messages: unknown[]; tools: unknown[] },
      { apiKey: string; sessionId: string },
    ];
    expect((model as unknown as { id: string }).id).toBe("claude-sonnet-4-5-20250929");
    expect(context.messages).toHaveLength(2);
    expect(context.tools).toHaveLength(1);
    expect(options.apiKey).toBe("secret");
    expect(options.sessionId).toBe("anthropic_main/claude-sonnet-4-5");
  });

  test("derives a default baseUrl for anthropic providers", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "stop" as const,
      content: [{ type: "text" as const, text: "ok" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };
    streamSimpleMock.mockReturnValue(
      createAssistantEventStream(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      ),
    );

    const bridge = new PiBridge();
    await bridge.streamTurn({
      model: createResolvedModel(),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    const [model] = streamSimpleMock.mock.calls[0] as [{ baseUrl: string }];
    expect(model.baseUrl).toBe("https://api.anthropic.com");
  });

  test("throws when pi returns an error stopReason", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "error" as const,
      errorMessage: "Request failed",
      content: [],
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };
    streamSimpleMock.mockReturnValue(
      createAssistantEventStream(
        [{ type: "error", reason: "error", error: finalMessage }],
        finalMessage,
      ),
    );

    const bridge = new PiBridge();
    await expect(
      bridge.streamTurn({
        model: createResolvedModel(),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Request failed");
  });

  test("completes a non-streaming turn through completeSimple", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "toolUse" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "tool_1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      timestamp: Date.now(),
    };
    completeSimpleMock.mockResolvedValue(finalMessage);

    const bridge = new PiBridge();
    const result = await bridge.completeTurn({
      model: createResolvedModel(),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      modelApi: "anthropic-messages",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "tool_1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    });
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
  });
});
