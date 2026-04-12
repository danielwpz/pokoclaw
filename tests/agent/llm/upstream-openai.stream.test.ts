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

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

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

describe("upstream openai responses streaming", () => {
  afterEach(() => {
    chatCompletionsCreateMock.mockReset();
    responsesCreateMock.mockReset();
  });

  test("preserves reasoning summaries and tool call arguments across responses stream events", async () => {
    responsesCreateMock.mockResolvedValue(
      createAsyncIterable([
        {
          type: "response.output_item.added",
          item: {
            type: "reasoning",
            id: "rs_123",
            summary: [],
          },
        },
        {
          type: "response.reasoning_summary_part.added",
          part: {
            type: "summary_text",
            text: "",
          },
        },
        {
          type: "response.reasoning_summary_text.delta",
          delta: "Need a tool.",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_123",
            summary: [
              {
                type: "summary_text",
                text: "Need a tool.",
              },
            ],
          },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_123",
            call_id: "call_123",
            name: "schedule_task",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          delta: '{"action":"create"}',
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_123",
            call_id: "call_123",
            name: "schedule_task",
            arguments: '{"action":"create"}',
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              input_tokens_details: {
                cached_tokens: 0,
              },
            },
          },
        },
      ]),
    );

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-responses",
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
    expect(result.stopReason).toBe("toolUse");
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "Need a tool.",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "rs_123",
        summary: [
          {
            type: "summary_text",
            text: "Need a tool.",
          },
        ],
      }),
    });
    expect(result.content[1]).toEqual({
      type: "toolCall",
      id: "call_123|fc_123",
      name: "schedule_task",
      arguments: { action: "create" },
      partialJson: '{"action":"create"}',
    });
  });

  test("preserves assistant text output from responses stream events", async () => {
    responsesCreateMock.mockResolvedValue(
      createAsyncIterable([
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "msg_123",
            role: "assistant",
            content: [],
          },
        },
        {
          type: "response.content_part.added",
          part: {
            type: "output_text",
            text: "",
            annotations: [],
          },
        },
        {
          type: "response.output_text.delta",
          delta: "POKOCLAW_RESPONSES_OK",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_123",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "POKOCLAW_RESPONSES_OK",
                annotations: [],
              },
            ],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              input_tokens_details: {
                cached_tokens: 0,
              },
            },
          },
        },
      ]),
    );

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-responses",
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
      text: "POKOCLAW_RESPONSES_OK",
      textSignature: JSON.stringify({
        v: 1,
        id: "msg_123",
      }),
    });
  });

  test("surfaces responses stream failures as assistant errors", async () => {
    responsesCreateMock.mockResolvedValue(
      createAsyncIterable([
        {
          type: "response.failed",
          response: {
            error: {
              code: "provider_error",
              message: "upstream exploded",
            },
          },
        },
      ]),
    );

    const stream = streamWithNormalizedUpstreamUsage(
      {
        api: "openai-responses",
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
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("provider_error: upstream exploded");
  });
});
