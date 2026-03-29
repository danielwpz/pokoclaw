import { describe, expect, test } from "vitest";
import {
  buildOpenAICompletionsParams,
  buildOpenAIResponsesParams,
  normalizeUsageFromOpenAICompatible,
  shouldUseCustomOpenAICompletionsStream,
  shouldUseCustomOpenAIResponsesStream,
  supportsUpstreamCostParser,
} from "@/src/agent/llm/upstream-openai.js";

const OPENROUTER_COMPLETIONS_MODEL = {
  api: "openai-completions" as const,
  baseUrl: "https://openrouter.ai/api/v1",
  cost: {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 3,
  },
};

const OPENROUTER_RESPONSES_MODEL = {
  api: "openai-responses" as const,
  baseUrl: "https://openrouter.ai/api/v1",
  cost: {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 3,
  },
};

const SIMPLE_CONTEXT = {
  systemPrompt: "You are a helpful assistant.",
  messages: [],
};

describe("upstream openai usage normalization", () => {
  test("uses upstream actual cost when available for completions usage", () => {
    const result = normalizeUsageFromOpenAICompatible(OPENROUTER_COMPLETIONS_MODEL, {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: {
        cached_tokens: 20,
        cache_write_tokens: 5,
      },
      completion_tokens_details: {
        reasoning_tokens: 7,
      },
      cost: 0.001,
      cost_details: {
        upstream_inference_prompt_cost: 0.0004,
        upstream_inference_completions_cost: 0.0006,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.costSource).toBe("actual");
    expect(result?.reasoningTokens).toBe(7);
    expect(result?.usage).toMatchObject({
      input: 75,
      output: 57,
      cacheRead: 20,
      cacheWrite: 5,
      totalTokens: 180,
      cost: {
        input: 0.0004,
        output: 0.0006,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.001,
      },
    });
  });

  test("uses upstream actual cost when available for responses usage", () => {
    const result = normalizeUsageFromOpenAICompatible(OPENROUTER_RESPONSES_MODEL, {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: {
        cached_tokens: 20,
      },
      output_tokens_details: {
        reasoning_tokens: 7,
      },
      cost: 0.001,
      cost_details: {
        upstream_inference_prompt_cost: 0.0004,
        upstream_inference_completions_cost: 0.0006,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.costSource).toBe("actual");
    expect(result?.reasoningTokens).toBe(7);
    expect(result?.usage).toMatchObject({
      input: 80,
      output: 50,
      cacheRead: 20,
      cacheWrite: 0,
      totalTokens: 150,
      cost: {
        input: 0.0004,
        output: 0.0006,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.001,
      },
    });
  });

  test("uses OpenRouter responses input/output cost details when available", () => {
    const result = normalizeUsageFromOpenAICompatible(OPENROUTER_RESPONSES_MODEL, {
      input_tokens: 33,
      output_tokens: 97,
      total_tokens: 130,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens_details: {
        reasoning_tokens: 82,
      },
      cost: 0.0015375,
      cost_details: {
        upstream_inference_cost: 0.0015375,
        upstream_inference_input_cost: 0.0000825,
        upstream_inference_output_cost: 0.001455,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.costSource).toBe("actual");
    expect(result?.reasoningTokens).toBe(82);
    expect(result?.usage).toMatchObject({
      input: 33,
      output: 97,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 130,
      cost: {
        input: 0.0000825,
        output: 0.001455,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.0015375,
      },
    });
  });

  test("falls back to configured estimated cost when upstream does not return cost", () => {
    const result = normalizeUsageFromOpenAICompatible(OPENROUTER_COMPLETIONS_MODEL, {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: {
        cached_tokens: 20,
        cache_write_tokens: 5,
      },
      completion_tokens_details: {
        reasoning_tokens: 7,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.costSource).toBe("estimated");
    expect(result?.usage.input).toBe(75);
    expect(result?.usage.output).toBe(57);
    expect(result?.usage.cacheRead).toBe(20);
    expect(result?.usage.cacheWrite).toBe(5);
    expect(result?.usage.totalTokens).toBe(157);
    expect(result?.usage.cost.total).toBeCloseTo(0.000214, 12);
  });

  test("returns null for invalid usage payloads", () => {
    expect(normalizeUsageFromOpenAICompatible(OPENROUTER_COMPLETIONS_MODEL, null)).toBeNull();
    expect(
      normalizeUsageFromOpenAICompatible(OPENROUTER_COMPLETIONS_MODEL, { foo: "bar" }),
    ).toBeNull();
  });

  test("exposes routing checks for custom upstream stream selection", () => {
    expect(supportsUpstreamCostParser(OPENROUTER_COMPLETIONS_MODEL)).toBe(true);
    expect(shouldUseCustomOpenAICompletionsStream(OPENROUTER_COMPLETIONS_MODEL)).toBe(true);
    expect(shouldUseCustomOpenAIResponsesStream(OPENROUTER_RESPONSES_MODEL)).toBe(true);
    expect(
      shouldUseCustomOpenAIResponsesStream({
        ...OPENROUTER_RESPONSES_MODEL,
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe(false);
  });

  test("uses system role for non-GPT openai-compatible completions models", () => {
    const params = buildOpenAICompletionsParams(
      {
        ...OPENROUTER_COMPLETIONS_MODEL,
        id: "anthropic/claude-sonnet-4.5",
        name: "claude-sonnet-4.5",
        provider: "openrouter",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
      SIMPLE_CONTEXT,
      undefined,
    );

    expect(params.messages[0]).toMatchObject({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  test("uses developer role for GPT-family openai-compatible completions models", () => {
    const params = buildOpenAICompletionsParams(
      {
        ...OPENROUTER_COMPLETIONS_MODEL,
        id: "openai/gpt-5",
        name: "gpt-5",
        provider: "openrouter",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
      SIMPLE_CONTEXT,
      undefined,
    );

    expect(params.messages[0]).toMatchObject({
      role: "developer",
      content: "You are a helpful assistant.",
    });
  });

  test("uses system role for non-GPT openai-compatible responses models", () => {
    const params = buildOpenAIResponsesParams(
      {
        ...OPENROUTER_RESPONSES_MODEL,
        id: "qwen/qwen3-32b",
        name: "qwen3-32b",
        provider: "openrouter",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
      SIMPLE_CONTEXT,
      undefined,
    );

    expect(Array.isArray(params.input)).toBe(true);
    if (!Array.isArray(params.input)) {
      throw new Error("expected array input");
    }
    expect(params.input[0]).toMatchObject({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  test("uses developer role for GPT-family openai-compatible responses models", () => {
    const params = buildOpenAIResponsesParams(
      {
        ...OPENROUTER_RESPONSES_MODEL,
        id: "openai/gpt-5",
        name: "gpt-5",
        provider: "openrouter",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 16_384,
      },
      SIMPLE_CONTEXT,
      undefined,
    );

    expect(Array.isArray(params.input)).toBe(true);
    if (!Array.isArray(params.input)) {
      throw new Error("expected array input");
    }
    expect(params.input[0]).toMatchObject({
      role: "developer",
      content: "You are a helpful assistant.",
    });
  });
});
