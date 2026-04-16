import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentLlmError, buildAgentLlmRawErrorPayload } from "@/src/agent/llm/errors.js";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import { PiBridge } from "@/src/agent/llm/pi-bridge.js";
import type { Message } from "@/src/storage/schema/types.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool } from "@/src/tools/core/types.js";

const { completeSimpleMock, streamSimpleMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  streamSimpleMock: vi.fn(),
}));
const { upstreamStreamMock } = vi.hoisted(() => ({
  upstreamStreamMock: vi.fn(),
}));
const { loggerDebugMock, loggerInfoMock, loggerErrorMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    completeSimple: completeSimpleMock,
    streamSimple: streamSimpleMock,
  };
});
vi.mock("@/src/agent/llm/upstream-openai.js", async () => {
  const actual = await vi.importActual<typeof import("@/src/agent/llm/upstream-openai.js")>(
    "@/src/agent/llm/upstream-openai.js",
  );
  return {
    ...actual,
    streamWithNormalizedUpstreamUsage: upstreamStreamMock,
  };
});
vi.mock("@/src/shared/logger.js", () => ({
  createSubsystemLogger: () => ({
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: vi.fn(),
    error: loggerErrorMock,
  }),
}));

function createResolvedModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    id: "anthropic_main/claude-sonnet-4-5",
    providerId: "anthropic_main",
    upstreamId: "claude-sonnet-4-5-20250929",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    reasoning: { enabled: true },
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
    channelParentMessageId: null,
    channelThreadId: null,
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
  beforeEach(() => {
    upstreamStreamMock.mockImplementation((model, context, options) =>
      streamSimpleMock(model, context, options),
    );
  });

  afterEach(() => {
    completeSimpleMock.mockReset();
    streamSimpleMock.mockReset();
    upstreamStreamMock.mockReset();
    loggerDebugMock.mockReset();
    loggerInfoMock.mockReset();
    loggerErrorMock.mockReset();
  });

  test("streams text deltas and returns a normalized assistant result", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "stop" as const,
      content: [
        { type: "thinking" as const, thinking: "Let me think..." },
        { type: "text" as const, text: "hello world" },
      ],
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
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Let me think...",
            partial: finalMessage,
          },
          {
            type: "text_delta",
            contentIndex: 1,
            delta: "hello ",
            partial: finalMessage,
          },
          {
            type: "text_delta",
            contentIndex: 1,
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
    const thinkingDeltas: Array<{ delta: string }> = [];
    const bridge = new PiBridge();
    const result = await bridge.streamTurn({
      model: createResolvedModel(),
      systemPrompt: "system prompt",
      compactSummary: "summary",
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry([
        defineTool({
          name: "bash",
          description: "Run a shell command",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            throw new Error("not used");
          },
        }),
      ]),
      signal: new AbortController().signal,
      onTextDelta(event) {
        deltas.push(event);
      },
      onThinkingDelta(event) {
        thinkingDeltas.push(event);
      },
    });

    expect(thinkingDeltas).toEqual([{ delta: "Let me think..." }]);
    expect(deltas).toEqual([
      { delta: "hello ", accumulatedText: "hello " },
      { delta: "world", accumulatedText: "hello world" },
    ]);
    expect(result).toEqual({
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "hello world" },
      ],
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
      { systemPrompt?: string; messages: unknown[]; tools: unknown[] },
      { apiKey: string; sessionId: string; reasoning: string },
    ];
    expect((model as unknown as { id: string }).id).toBe("claude-sonnet-4-5-20250929");
    expect(context.systemPrompt).toBe("system prompt");
    expect(context.messages).toHaveLength(2);
    expect(context.tools).toHaveLength(1);
    expect(options.apiKey).toBe("secret");
    expect(options.sessionId).toBe("anthropic_main/claude-sonnet-4-5");
    expect(options.reasoning).toBe("medium");
  });

  test("passes configured max output tokens into stream options", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "openai-completions" as const,
      provider: "volces",
      model: "doubao-seed-2.0-pro",
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
      model: createResolvedModel({
        id: "volces-doubao-seed-2.0-pro",
        providerId: "volces",
        upstreamId: "doubao-seed-2.0-pro",
        maxOutputTokens: 128_000,
        provider: {
          id: "volces",
          api: "openai-completions",
          apiKey: "secret",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        },
      }),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    const [, , options] = streamSimpleMock.mock.calls.at(-1) as [
      ResolvedModel,
      { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
      { maxTokens?: number },
    ];
    expect(options.maxTokens).toBe(128_000);
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

  test("routes non-gpt responses models through openai completions", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "openai-completions" as const,
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
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
    const result = await bridge.streamTurn({
      model: createResolvedModel({
        id: "openrouter-minimax2.7",
        providerId: "openrouter",
        upstreamId: "minimax/minimax-m2.7",
        provider: {
          id: "openrouter",
          api: "openai-responses",
          apiKey: "secret",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      }),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    const [effectiveModel] = upstreamStreamMock.mock.calls.at(-1) as [
      {
        api: string;
        baseUrl: string;
        compat?: {
          supportsDeveloperRole?: boolean;
        };
      },
    ];
    expect(effectiveModel.api).toBe("openai-completions");
    expect(effectiveModel.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(effectiveModel.compat?.supportsDeveloperRole).toBe(false);
    expect(result.modelApi).toBe("openai-completions");
  });

  test("keeps gpt responses models on the responses api", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "openai-responses" as const,
      provider: "openrouter",
      model: "openai/gpt-5.4",
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
    const result = await bridge.streamTurn({
      model: createResolvedModel({
        id: "openrouter-gpt5.4",
        providerId: "openrouter",
        upstreamId: "openai/gpt-5.4",
        provider: {
          id: "openrouter",
          api: "openai-responses",
          apiKey: "secret",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      }),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    const [effectiveModel] = upstreamStreamMock.mock.calls.at(-1) as [
      {
        api: string;
        baseUrl: string;
        compat?: {
          supportsDeveloperRole?: boolean;
        };
      },
    ];
    expect(effectiveModel.api).toBe("openai-responses");
    expect(effectiveModel.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(effectiveModel.compat?.supportsDeveloperRole).toBe(false);
    expect(result.modelApi).toBe("openai-responses");
  });

  test("only exposes approval-session tools to the model during approval turns", async () => {
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
      tools: new ToolRegistry([
        defineTool({
          name: "bash",
          description: "Run a shell command",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            throw new Error("not used");
          },
        }),
        defineTool({
          name: "read",
          description: "Read a file",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            throw new Error("not used");
          },
        }),
        defineTool({
          name: "review_permission_request",
          description: "Review a delegated approval request",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            throw new Error("not used");
          },
        }),
      ]),
      sessionPurpose: "approval",
      signal: new AbortController().signal,
    });

    const [, context] = streamSimpleMock.mock.calls[0] as [
      ResolvedModel,
      { tools: Array<{ name: string }> },
    ];
    expect(context.tools.map((tool) => tool.name)).toEqual(["read", "review_permission_request"]);
  });

  test("only exposes create_subagent to the main-agent chat surface", async () => {
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

    const tools = new ToolRegistry([
      defineTool({
        name: "create_subagent",
        description: "Create a subagent",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw new Error("not used");
        },
      }),
      defineTool({
        name: "read",
        description: "Read a file",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw new Error("not used");
        },
      }),
    ]);
    const bridge = new PiBridge();

    await bridge.streamTurn({
      model: createResolvedModel(),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools,
      sessionPurpose: "chat",
      agentKind: "sub",
      signal: new AbortController().signal,
    });

    const [, subagentContext] = streamSimpleMock.mock.calls[0] as [
      ResolvedModel,
      { tools: Array<{ name: string }> },
    ];
    expect(subagentContext.tools.map((tool) => tool.name)).toEqual(["read"]);

    await bridge.streamTurn({
      model: createResolvedModel(),
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools,
      sessionPurpose: "chat",
      agentKind: "main",
      signal: new AbortController().signal,
    });

    const [, mainAgentContext] = streamSimpleMock.mock.calls[1] as [
      ResolvedModel,
      { tools: Array<{ name: string }> },
    ];
    expect(mainAgentContext.tools.map((tool) => tool.name)).toEqual(["create_subagent", "read"]);
  });

  test("normalizes pi stopReason errors into AgentLlmError", async () => {
    const finalMessage = {
      role: "assistant" as const,
      api: "anthropic-messages" as const,
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
      stopReason: "error" as const,
      errorMessage: "API rate limit reached",
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
    const error = await bridge
      .streamTurn({
        model: createResolvedModel(),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentLlmError);
    expect(error).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      message: "API rate limit reached",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5-20250929",
    });
  });

  test("normalizes thrown upstream exceptions into AgentLlmError", async () => {
    streamSimpleMock.mockImplementation(() => {
      throw new Error("prompt is too long: 213462 tokens > 200000 maximum");
    });

    const bridge = new PiBridge();
    const error = await bridge
      .streamTurn({
        model: createResolvedModel(),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentLlmError);
    expect(error).toMatchObject({
      kind: "context_overflow",
      retryable: false,
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "raw llm failure before normalization",
      expect.objectContaining({
        phase: "stream",
        provider: "anthropic_main",
        providerApi: "anthropic-messages",
        modelId: "anthropic_main/claude-sonnet-4-5",
        upstreamModelId: "claude-sonnet-4-5-20250929",
        errorName: "Error",
        errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
      }),
    );
  });

  test("logs raw structured upstream failure details before normalization", async () => {
    streamSimpleMock.mockImplementation(() => {
      const cause = Object.assign(new Error("upstream socket closed"), {
        code: "UND_ERR_SOCKET",
        status: 529,
      });
      const error = Object.assign(new Error("terminated"), {
        cause,
        response: { status: 529 },
      });
      throw error;
    });

    const bridge = new PiBridge();
    await bridge
      .streamTurn({
        model: createResolvedModel(),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch(() => undefined);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "raw llm failure before normalization",
      expect.objectContaining({
        phase: "stream",
        provider: "anthropic_main",
        providerApi: "anthropic-messages",
        modelId: "anthropic_main/claude-sonnet-4-5",
        upstreamModelId: "claude-sonnet-4-5-20250929",
        errorName: "Error",
        errorMessage: "terminated",
        responseStatus: 529,
        causeName: "Error",
        causeMessage: "upstream socket closed",
        serializedError: expect.stringContaining("upstream socket closed"),
      }),
    );
  });

  test("preserves structured assistant error payloads through normalization", async () => {
    const rawPayload = buildAgentLlmRawErrorPayload(
      Object.assign(new Error("terminated"), {
        response: { status: 529 },
        cause: Object.assign(new Error("upstream socket closed"), {
          code: "UND_ERR_SOCKET",
        }),
      }),
    );

    streamSimpleMock.mockReturnValue(
      createAssistantEventStream(
        [],
        Object.assign(
          {
            role: "assistant" as const,
            api: "anthropic-messages" as const,
            provider: "anthropic_main",
            model: "claude-sonnet-4-5-20250929",
            stopReason: "error" as const,
            content: [],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            errorMessage: "terminated",
            timestamp: Date.now(),
          } satisfies AssistantMessage,
          { pokoclawRawError: rawPayload },
        ),
      ),
    );

    const bridge = new PiBridge();
    const error = await bridge
      .streamTurn({
        model: createResolvedModel(),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentLlmError);
    expect(error).toMatchObject({
      kind: "overloaded",
      message: "terminated",
      rawMessage: "terminated | upstream socket closed",
      rawDetails: expect.objectContaining({
        responseStatus: 529,
        causeMessage: "upstream socket closed",
      }),
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "raw llm failure before normalization",
      expect.objectContaining({
        phase: "stream",
        errorName: "AgentLlmError",
        errorMessage: "terminated",
        rawMessage: "terminated | upstream socket closed",
        responseStatus: 529,
        causeMessage: "upstream socket closed",
        serializedError: expect.stringContaining("upstream socket closed"),
      }),
    );
  });

  test("enriches generic codex fetch failures returned from assistant results", async () => {
    streamSimpleMock.mockReturnValue(
      createAssistantEventStream([], {
        role: "assistant" as const,
        api: "openai-codex-responses" as const,
        provider: "openai_codex",
        model: "gpt-5.4",
        stopReason: "error" as const,
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        errorMessage: "fetch failed",
        timestamp: Date.now(),
      } satisfies AssistantMessage),
    );

    const bridge = new PiBridge();
    const error = await bridge
      .streamTurn({
        model: createResolvedModel({
          id: "codex-gpt5.4",
          upstreamId: "gpt-5.4",
          providerId: "openai_codex",
          provider: {
            id: "openai_codex",
            api: "openai-codex-responses",
            authSource: "codex-local",
          },
        }),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentLlmError);
    expect(error).toMatchObject({
      kind: "upstream",
      message: "fetch failed",
      rawMessage: expect.stringContaining(
        "openai_codex backend request failed before an HTTP response was received",
      ),
      rawDetails: expect.objectContaining({
        providerApi: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        authSource: "codex-local",
        diagnosticStage: "request",
      }),
    });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "raw llm failure before normalization",
      expect.objectContaining({
        provider: "openai_codex",
        providerApi: "openai-codex-responses",
        modelId: "codex-gpt5.4",
        errorMessage: "fetch failed",
        diagnosticStage: "request",
        diagnosticHint: "openai_codex backend request failed before an HTTP response was received",
      }),
    );
  });

  test("enriches codex-local auth fetch failures before request dispatch", async () => {
    const bridge = new PiBridge({
      async resolveApiKey() {
        throw new Error("fetch failed");
      },
    });

    const error = await bridge
      .streamTurn({
        model: createResolvedModel({
          id: "codex-gpt5.4",
          upstreamId: "gpt-5.4",
          providerId: "openai_codex",
          provider: {
            id: "openai_codex",
            api: "openai-codex-responses",
            authSource: "codex-local",
          },
        }),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentLlmError);
    expect(error).toMatchObject({
      kind: "upstream",
      message: "fetch failed",
      rawMessage: expect.stringContaining(
        "codex-local auth resolution failed before an HTTP response was received",
      ),
      rawDetails: expect.objectContaining({
        providerApi: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        authSource: "codex-local",
        diagnosticStage: "auth",
      }),
    });
  });

  test("marks regional availability upstream failures as non-retryable", async () => {
    streamSimpleMock.mockImplementation(() => {
      throw new Error("403 This model is not available in your region.");
    });

    const bridge = new PiBridge();
    const error = await bridge
      .streamTurn({
        model: createResolvedModel(),
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AgentLlmError);
    expect(error).toMatchObject({
      kind: "upstream",
      retryable: false,
      message: "403 This model is not available in your region.",
    });
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
