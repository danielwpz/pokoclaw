import type { Context, Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import { describe, expect, test } from "vitest";

const USAGE = {
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
};

const DEEPSEEK_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  reasoningEffortMap: {
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
  },
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: true,
  cacheControlFormat: undefined,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: true,
} satisfies ResolvedOpenAICompletionsCompat;

const OPENAI_COMPAT = {
  ...DEEPSEEK_COMPAT,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  reasoningEffortMap: {},
} satisfies ResolvedOpenAICompletionsCompat;

type ResolvedOpenAICompletionsCompat = Omit<
  Required<OpenAICompletionsCompat>,
  "cacheControlFormat"
> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

const DEEPSEEK_MODEL = {
  api: "openai-completions",
  id: "deepseek-v4-pro",
  name: "deepseek-v4-pro",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 32_000,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
} satisfies Model<"openai-completions">;

const OPENROUTER_MODEL = {
  ...DEEPSEEK_MODEL,
  id: "openrouter/qwen",
  name: "openrouter/qwen",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
} satisfies Model<"openai-completions">;

describe("DeepSeek thinking replay conversion", () => {
  test("replays persisted DeepSeek thinking as reasoning_content for tool-call history", () => {
    const messages = convertMessages(
      DEEPSEEK_MODEL,
      {
        messages: [
          userMessage("Use a tool."),
          assistantMessage({
            provider: "deepseek",
            model: "deepseek-v4-pro",
            content: [
              {
                type: "thinking",
                thinking: "Need to call the date tool.",
                thinkingSignature: "reasoning_content",
              },
              toolCallBlock(),
            ],
          }),
          toolResultMessage(),
        ],
      },
      DEEPSEEK_COMPAT,
    );

    const assistant = findAssistantMessage(messages);
    expect(assistant).toMatchObject({
      role: "assistant",
      reasoning_content: "Need to call the date tool.",
      tool_calls: [
        {
          id: "call_date",
          type: "function",
          function: {
            name: "get_date",
            arguments: "{}",
          },
        },
      ],
    });
  });

  test("adds empty reasoning_content for legacy DeepSeek tool-call history without thinking", () => {
    const messages = convertMessages(
      DEEPSEEK_MODEL,
      {
        messages: [
          userMessage("Use a tool."),
          assistantMessage({
            provider: "deepseek",
            model: "deepseek-v4-pro",
            content: [toolCallBlock()],
          }),
          toolResultMessage(),
        ],
      },
      DEEPSEEK_COMPAT,
    );

    expect(findAssistantMessage(messages)).toMatchObject({
      role: "assistant",
      reasoning_content: "",
      tool_calls: expect.any(Array),
    });
  });

  test("does not add DeepSeek reasoning_content for non-DeepSeek targets", () => {
    const messages = convertMessages(
      OPENROUTER_MODEL,
      {
        messages: [
          userMessage("Use a tool."),
          assistantMessage({
            provider: "openrouter",
            model: "openrouter/qwen",
            content: [toolCallBlock()],
          }),
          toolResultMessage(),
        ],
      },
      OPENAI_COMPAT,
    );

    expect(findAssistantMessage(messages)).not.toHaveProperty("reasoning_content");
  });

  test("adds empty reasoning_content when switching legacy non-DeepSeek tool history to DeepSeek", () => {
    const messages = convertMessages(
      DEEPSEEK_MODEL,
      {
        messages: [
          userMessage("Use a tool."),
          assistantMessage({
            provider: "openrouter",
            model: "openrouter/qwen",
            content: [toolCallBlock()],
          }),
          toolResultMessage(),
        ],
      },
      DEEPSEEK_COMPAT,
    );

    expect(findAssistantMessage(messages)).toMatchObject({
      role: "assistant",
      reasoning_content: "",
      tool_calls: expect.any(Array),
    });
  });

  test("does not leak DeepSeek reasoning_content when switching from DeepSeek to another model", () => {
    const messages = convertMessages(
      OPENROUTER_MODEL,
      {
        messages: [
          userMessage("Use a tool."),
          assistantMessage({
            provider: "deepseek",
            model: "deepseek-v4-pro",
            content: [
              {
                type: "thinking",
                thinking: "DeepSeek-only thinking.",
                thinkingSignature: "reasoning_content",
              },
              toolCallBlock(),
            ],
          }),
          toolResultMessage(),
        ],
      },
      OPENAI_COMPAT,
    );

    const assistant = findAssistantMessage(messages);
    expect(assistant).not.toHaveProperty("reasoning_content");
    expect(assistant).toMatchObject({
      role: "assistant",
      content: "DeepSeek-only thinking.",
      tool_calls: expect.any(Array),
    });
  });
});

function userMessage(content: string): Context["messages"][number] {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function assistantMessage(input: {
  provider: string;
  model: string;
  content: Extract<Context["messages"][number], { role: "assistant" }>["content"];
}): Context["messages"][number] {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: input.provider,
    model: input.model,
    content: input.content,
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolCallBlock(): Extract<
  Extract<Context["messages"][number], { role: "assistant" }>["content"][number],
  { type: "toolCall" }
> {
  return {
    type: "toolCall",
    id: "call_date",
    name: "get_date",
    arguments: {},
  };
}

function toolResultMessage(): Context["messages"][number] {
  return {
    role: "toolResult",
    toolCallId: "call_date",
    toolName: "get_date",
    content: [{ type: "text", text: "2026-04-26" }],
    isError: false,
    timestamp: Date.now(),
  };
}

function findAssistantMessage(messages: unknown[]): Record<string, unknown> {
  const assistant = messages.find(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant",
  );
  if (assistant == null) {
    throw new Error("Expected converted assistant message");
  }
  return assistant;
}
