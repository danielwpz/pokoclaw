import { afterEach, describe, expect, test, vi } from "vitest";

const { chatCompletionsCreateMock, responsesCreateMock } = vi.hoisted(() => ({
  chatCompletionsCreateMock: vi.fn(),
  responsesCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: chatCompletionsCreateMock,
      },
    };

    responses = {
      create: responsesCreateMock,
    };
  },
}));

import { streamWithNormalizedUpstreamUsage } from "@/src/agent/llm/upstream-openai.js";

describe("upstream openai completions streaming", () => {
  afterEach(() => {
    chatCompletionsCreateMock.mockReset();
    responsesCreateMock.mockReset();
  });

  test("preserves reasoning field signatures and attaches reasoning details to tool calls", async () => {
    chatCompletionsCreateMock.mockReturnValue({
      asResponse: vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"choices":[{"finish_reason":null,"delta":{"reasoning_content":"Need a tool."}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
            "",
            'data: {"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"schedule_task","arguments":"{\\"action\\":\\"create\\"}"}}],"reasoning_details":[{"type":"reasoning.encrypted","id":"call_123","data":"encrypted-signature"}]}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    });

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-completions",
        id: "minimax/minimax-m2.7",
        name: "minimax-m2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [],
      },
      {
        apiKey: "secret",
        reasoning: "medium",
      },
    );

    for await (const _event of stream) {
      // Fully drain the stream before reading the final result.
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Need a tool.",
      thinkingSignature: "reasoning_content",
    });
    expect(result.content[1]).toMatchObject({
      type: "toolCall",
      id: "call_123",
      name: "schedule_task",
      arguments: { action: "create" },
      thoughtSignature: JSON.stringify({
        type: "reasoning.encrypted",
        id: "call_123",
        data: "encrypted-signature",
      }),
    });
  });

  test("attaches reasoning details delivered in a later chunk to an existing tool call", async () => {
    chatCompletionsCreateMock.mockReturnValue({
      asResponse: vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"name":"schedule_task","arguments":"{\\"action\\":\\"create\\"}"}}]}}]}',
            "",
            'data: {"choices":[{"finish_reason":"tool_calls","delta":{"reasoning_details":[{"type":"reasoning.encrypted","id":"call_late","data":"late-signature"}]}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    });

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-completions",
        id: "minimax/minimax-m2.7",
        name: "minimax-m2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [],
      },
      {
        apiKey: "secret",
        reasoning: "medium",
      },
    );

    for await (const _event of stream) {
      // Fully drain the stream before reading the final result.
    }

    const result = await stream.result();
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_late",
      thoughtSignature: JSON.stringify({
        type: "reasoning.encrypted",
        id: "call_late",
        data: "late-signature",
      }),
    });
  });

  test("attaches reasoning details delivered before the tool call once the tool call arrives", async () => {
    chatCompletionsCreateMock.mockReturnValue({
      asResponse: vi.fn().mockResolvedValue(
        new Response(
          [
            'data: {"choices":[{"finish_reason":null,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","id":"call_early","data":"early-signature"}]}}]}',
            "",
            'data: {"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"index":0,"id":"call_early","function":{"name":"schedule_task","arguments":"{\\"action\\":\\"create\\"}"}}]}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    });

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-completions",
        id: "minimax/minimax-m2.7",
        name: "minimax-m2.7",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [],
      },
      {
        apiKey: "secret",
        reasoning: "medium",
      },
    );

    for await (const _event of stream) {
      // Fully drain the stream before reading the final result.
    }

    const result = await stream.result();
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: "call_early",
      thoughtSignature: JSON.stringify({
        type: "reasoning.encrypted",
        id: "call_early",
        data: "early-signature",
      }),
    });
  });

  test("flushes a trailing SSE event when the stream ends without a blank-line terminator", async () => {
    chatCompletionsCreateMock.mockReturnValue({
      asResponse: vi.fn().mockResolvedValue(
        new Response(
          'data: {"choices":[{"finish_reason":"stop","delta":{"content":"POKOCLAW_LOOP_OK"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}',
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          },
        ),
      ),
    });

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-completions",
        id: "openai/gpt-5.4",
        name: "gpt-5.4",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [],
      },
      {
        apiKey: "secret",
        reasoning: "medium",
      },
    );

    for await (const _event of stream) {
      // Fully drain the stream before reading the final result.
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "POKOCLAW_LOOP_OK",
    });
  });
});
