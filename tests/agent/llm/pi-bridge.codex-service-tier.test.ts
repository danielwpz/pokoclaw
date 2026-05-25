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
      type: "response.completed",
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

  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("pi bridge Codex service tier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sends configured fast service tier in the final streaming Codex HTTP request body", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({
          url: String(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        });
        return createSseResponse();
      }),
    );

    const bridge = new PiBridge();
    const result = await bridge.streamTurn({
      model: createCodexModel({ serviceTier: "fast" }),
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
      service_tier: "priority",
    });
  });
});
