import { afterEach, describe, expect, test, vi } from "vitest";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import { PiBridge } from "@/src/agent/llm/pi-bridge.js";
import type { Message } from "@/src/storage/schema/types.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";

function createCodexAccessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function captureRequest(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  return {
    url: String(input),
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    headers: new Headers(init?.headers),
  };
}

function createCodexModel(overrides?: Partial<ResolvedModel>): ResolvedModel {
  return {
    id: "codex-gpt5.5-fast",
    providerId: "openai_codex",
    upstreamId: "gpt-5.5",
    contextWindow: 400_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    reasoning: { enabled: true, effort: "high" },
    provider: {
      id: "openai_codex",
      api: "openai-codex-responses",
      apiKey: createCodexAccessToken(),
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
    payloadJson: JSON.stringify({ content: "Say ok." }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: "2026-03-22T00:00:01.000Z",
  };
}

function createStoredDeepSeekAssistantMessage(): Message {
  return {
    id: "msg_deepseek_assistant",
    sessionId: "sess_1",
    seq: 2,
    role: "assistant",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    modelApi: "openai-completions",
    stopReason: "stop",
    errorMessage: null,
    payloadJson: JSON.stringify({
      content: [
        {
          type: "thinking",
          thinking: "Private reasoning from a different provider.",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "Visible answer from the same assistant message.",
        },
      ],
    }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: JSON.stringify({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    }),
    createdAt: "2026-03-22T00:00:02.000Z",
  };
}

function createStoredFollowUpUserMessage(): Message {
  return {
    ...createStoredUserMessage(),
    id: "msg_user_2",
    seq: 3,
    payloadJson: JSON.stringify({ content: "Continue." }),
    createdAt: "2026-03-22T00:00:03.000Z",
  };
}

function createSseResponseFromEvents(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createSseResponse(): Response {
  const messageItem = {
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      item: { ...messageItem, content: [] },
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      delta: "ok",
    },
    {
      type: "response.output_item.done",
      item: messageItem,
    },
    {
      type: "response.done",
      response: {
        id: "resp_test",
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
        service_tier: "priority",
      },
    },
  ];

  return createSseResponseFromEvents(events);
}

describe("pi bridge Codex service tier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    ["fast", "priority"],
    ["flex", "flex"],
  ] as const)("sends configured %s service tier as %s without unsupported token cap in the final streaming Codex HTTP request body", async (configuredTier, requestTier) => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(captureRequest(input, init));
        return createSseResponse();
      }),
    );

    const bridge = new PiBridge();
    const result = await bridge.streamTurn({
      model: createCodexModel({ serviceTier: configuredTier }),
      systemPrompt: "You are concise.",
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(result.content).toMatchObject([{ type: "text", text: "ok" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-5.5",
      service_tier: requestTier,
    });
    expect(requests[0]?.body).not.toHaveProperty("max_output_tokens");
    expect(requests[0]?.body).not.toHaveProperty("tool_choice");
    expect(requests[0]?.body).not.toHaveProperty("parallel_tool_calls");
    expect(requests[0]?.body).not.toHaveProperty("tools");
  });

  test("sends unique fallback response item ids for cross-provider assistant history", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(captureRequest(input, init));
        return createSseResponse();
      }),
    );

    const bridge = new PiBridge();
    await bridge.streamTurn({
      model: createCodexModel(),
      systemPrompt: "You are concise.",
      compactSummary: null,
      messages: [
        createStoredUserMessage(),
        createStoredDeepSeekAssistantMessage(),
        createStoredFollowUpUserMessage(),
      ],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    const body = requests[0]?.body as { input?: Array<{ id?: string; type?: string }> };
    const itemIds = (body.input ?? [])
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.id);

    expect(itemIds).toHaveLength(2);
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  test("uses the local Codex converter for non-streaming bridge turns", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(captureRequest(input, init));
        return createSseResponse();
      }),
    );

    const bridge = new PiBridge();
    const result = await bridge.completeTurn({
      model: createCodexModel(),
      systemPrompt: "You are concise.",
      compactSummary: null,
      messages: [
        createStoredUserMessage(),
        createStoredDeepSeekAssistantMessage(),
        createStoredFollowUpUserMessage(),
      ],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(result.content).toMatchObject([{ type: "text", text: "ok" }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-5.5",
      stream: true,
    });
    expect(requests[0]?.body).not.toHaveProperty("max_output_tokens");
    const input = requests[0]?.body.input;
    expect(Array.isArray(input)).toBe(true);
    if (!Array.isArray(input)) {
      throw new Error("expected responses input array");
    }
    const itemIds = input
      .flatMap((item) => (typeof item === "object" && item != null ? [item] : []))
      .map((item) => (item as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  test("uses resolver-provided Codex account id when the bearer token is opaque", async () => {
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(captureRequest(input, init));
        return createSseResponse();
      }),
    );

    const bridge = new PiBridge({
      async resolveApiKey() {
        return { apiKey: "opaque-codex-access-token", accountId: "acct_from_store" };
      },
    });

    await bridge.streamTurn({
      model: createCodexModel({
        provider: {
          id: "openai_codex",
          api: "openai-codex-responses",
          authSource: "codex-local",
        },
      }),
      systemPrompt: "You are concise.",
      compactSummary: null,
      messages: [createStoredUserMessage()],
      tools: new ToolRegistry(),
      signal: new AbortController().signal,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer opaque-codex-access-token");
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct_from_store");
  });

  test("preserves Codex failed done event details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponseFromEvents([
          {
            type: "response.done",
            response: {
              id: "resp_failed",
              status: "failed",
              error: {
                code: "invalid_request_error",
                message: "Codex rejected duplicate item ids",
              },
            },
          },
        ]),
      ),
    );

    const bridge = new PiBridge();
    await expect(
      bridge.streamTurn({
        model: createCodexModel(),
        systemPrompt: "You are concise.",
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("invalid_request_error: Codex rejected duplicate item ids");
  });

  test("preserves Codex failed done event details for non-streaming bridge turns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponseFromEvents([
          {
            type: "response.done",
            response: {
              id: "resp_failed",
              status: "failed",
              error: {
                code: "invalid_request_error",
                message: "Codex rejected duplicate item ids",
              },
            },
          },
        ]),
      ),
    );

    const bridge = new PiBridge();
    await expect(
      bridge.completeTurn({
        model: createCodexModel(),
        systemPrompt: "You are concise.",
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("invalid_request_error: Codex rejected duplicate item ids");
  });

  test("rejects malformed Codex stream events before response processing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        createSseResponseFromEvents([
          {
            type: "response.output_text.delta",
            delta: 123,
          },
          {
            type: "response.done",
            response: {
              id: "resp_test",
              status: "completed",
            },
          },
        ]),
      ),
    );

    const bridge = new PiBridge();
    await expect(
      bridge.streamTurn({
        model: createCodexModel(),
        systemPrompt: "You are concise.",
        compactSummary: null,
        messages: [createStoredUserMessage()],
        tools: new ToolRegistry(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid Codex response.output_text.delta event");
  });
});
