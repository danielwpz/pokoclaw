/**
 * OpenAI-compatible streaming adapter overrides.
 *
 * Extends pi-ai's default OpenAI path to preserve provider-specific fidelity
 * (especially usage/reasoning stream handling) while keeping a uniform bridge
 * interface for the rest of runtime.
 */
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import {
  type Api,
  type AssistantMessage,
  type Context,
  convertMessages,
  createAssistantMessageEventStream,
  type Model,
  type OpenAICompletionsCompat,
  parseStreamingJson,
  type SimpleStreamOptions,
  type StopReason,
  streamSimple,
  type Tool,
  type Usage,
} from "@mariozechner/pi-ai";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
// This import intentionally targets pi-ai internals. We need the responses
// stream parser to preserve event fidelity while overriding usage normalization.
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "../../../node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js";

type CostedModel = Pick<Model<Api>, "api" | "baseUrl" | "cost">;

interface OpenAICompatibleUsageRaw {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  cost_details?: {
    upstream_inference_prompt_cost?: number;
    upstream_inference_completions_cost?: number;
    upstream_inference_input_cost?: number;
    upstream_inference_output_cost?: number;
    upstream_inference_cost?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens: number;
}

interface ParsedActualCost {
  input?: number;
  output?: number;
  total?: number;
}

interface UpstreamCostParser {
  supports(model: Pick<Model<Api>, "baseUrl">): boolean;
  parse(rawUsage: OpenAICompatibleUsageRaw): ParsedActualCost | null;
}

export type UsageCostSource = "actual" | "estimated";

export interface NormalizedUsageResult {
  usage: Usage;
  costSource: UsageCostSource;
  reasoningTokens: number;
}

const OPENROUTER_COST_PARSER: UpstreamCostParser = {
  supports(model) {
    return model.baseUrl.includes("openrouter.ai");
  },
  parse(rawUsage) {
    const input =
      toNumber(rawUsage.cost_details?.upstream_inference_input_cost) ??
      toNumber(rawUsage.cost_details?.upstream_inference_prompt_cost);
    const output =
      toNumber(rawUsage.cost_details?.upstream_inference_output_cost) ??
      toNumber(rawUsage.cost_details?.upstream_inference_completions_cost);
    const total =
      toNumber(rawUsage.cost) ?? toNumber(rawUsage.cost_details?.upstream_inference_cost);

    const parsed: ParsedActualCost = {};
    if (input !== undefined) parsed.input = input;
    if (output !== undefined) parsed.output = output;
    if (total !== undefined) parsed.total = total;
    return Object.keys(parsed).length === 0 ? null : parsed;
  },
};

const COST_PARSERS: UpstreamCostParser[] = [OPENROUTER_COST_PARSER];

const DEFAULT_COMPAT: Required<OpenAICompletionsCompat> = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  reasoningEffortMap: {},
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: true,
};

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export function supportsUpstreamCostParser(model: Pick<Model<Api>, "baseUrl">): boolean {
  return COST_PARSERS.some((parser) => parser.supports(model));
}

export function shouldUseCustomOpenAICompletionsStream(
  model: Pick<Model<Api>, "api" | "baseUrl">,
): boolean {
  return model.api === "openai-completions" && supportsUpstreamCostParser(model);
}

export function shouldUseCustomOpenAIResponsesStream(
  model: Pick<Model<Api>, "api" | "baseUrl">,
): boolean {
  return model.api === "openai-responses" && supportsUpstreamCostParser(model);
}

export function normalizeUsageFromOpenAICompatible(
  model: CostedModel,
  rawUsage: unknown,
): NormalizedUsageResult | null {
  const parsedRawUsage = parseRawUsage(rawUsage);
  if (!parsedRawUsage) return null;

  const tokens = extractTokenBreakdown(parsedRawUsage);
  const actualCost = resolveActualCost(model, parsedRawUsage);

  if (actualCost) {
    const input = actualCost.input ?? 0;
    const output = actualCost.output ?? 0;
    const total = actualCost.total ?? input + output;
    return {
      usage: buildUsage(tokens, {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        total,
      }),
      costSource: "actual",
      reasoningTokens: tokens.reasoningTokens,
    };
  }

  return {
    usage: buildUsage(tokens, estimateCost(model, tokens)),
    costSource: "estimated",
    reasoningTokens: tokens.reasoningTokens,
  };
}

export function streamWithNormalizedUpstreamUsage(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (shouldUseCustomOpenAICompletionsStream(model)) {
    return streamOpenAICompletionsWithUpstreamUsage(
      model as Model<"openai-completions">,
      context,
      options,
    );
  }

  if (shouldUseCustomOpenAIResponsesStream(model)) {
    return streamOpenAIResponsesWithUpstreamUsage(
      model as Model<"openai-responses">,
      context,
      options,
    );
  }

  return streamSimple(model, context, options);
}

function streamOpenAICompletionsWithUpstreamUsage(
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error("OpenAI-compatible API key is missing");
      }

      const client = new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
      });

      const params = buildOpenAICompletionsParams(model, context, options);
      const openaiStream = await client.chat.completions.create(params, {
        signal: options?.signal,
      });

      stream.push({ type: "start", partial: output });

      let currentBlock:
        | { type: "text"; text: string }
        | { type: "thinking"; thinking: string; thinkingSignature: string }
        | null = null;
      const toolCallContentIndexByStreamIndex = new Map<number, number>();
      const toolCallPartialArgsByContentIndex = new Map<number, string>();

      const finishCurrentBlock = () => {
        if (currentBlock == null) return;

        const contentIndex = output.content.length - 1;
        if (currentBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: currentBlock.text,
            partial: output,
          });
        } else {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: currentBlock.thinking,
            partial: output,
          });
        }

        currentBlock = null;
      };

      for await (const chunk of openaiStream) {
        const normalizedUsage = normalizeUsageFromOpenAICompatible(model, chunk.usage);
        if (normalizedUsage) {
          output.usage = normalizedUsage.usage;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          output.stopReason = mapCompletionStopReason(choice.finish_reason);
        }

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock();
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }

          currentBlock.text += delta.content;
          stream.push({
            type: "text_delta",
            contentIndex: output.content.length - 1,
            delta: delta.content,
            partial: output,
          });
        }

        const reasoningDelta =
          readString(delta, "reasoning_content") ??
          readString(delta, "reasoning") ??
          readString(delta, "reasoning_text");

        if (reasoningDelta) {
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock();
            currentBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "reasoning",
            };
            output.content.push(currentBlock);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }

          currentBlock.thinking += reasoningDelta;
          stream.push({
            type: "thinking_delta",
            contentIndex: output.content.length - 1,
            delta: reasoningDelta,
            partial: output,
          });
        }

        const toolCalls = delta.tool_calls as
          | Array<{
              index?: number;
              id?: string;
              function?: {
                name?: string;
                arguments?: string;
              };
            }>
          | undefined;
        if (!toolCalls || toolCalls.length === 0) {
          continue;
        }

        finishCurrentBlock();

        for (const toolCallDelta of toolCalls) {
          const streamIndex = toolCallDelta.index ?? 0;
          let contentIndex = toolCallContentIndexByStreamIndex.get(streamIndex);

          if (contentIndex === undefined) {
            const block = {
              type: "toolCall" as const,
              id: toolCallDelta.id ?? "",
              name: toolCallDelta.function?.name ?? "",
              arguments: {},
            };
            output.content.push(block);
            contentIndex = output.content.length - 1;
            toolCallContentIndexByStreamIndex.set(streamIndex, contentIndex);
            toolCallPartialArgsByContentIndex.set(contentIndex, "");
            stream.push({
              type: "toolcall_start",
              contentIndex,
              partial: output,
            });
          }

          const block = output.content[contentIndex];
          if (!block || block.type !== "toolCall") {
            continue;
          }

          if (toolCallDelta.id) block.id = toolCallDelta.id;
          if (toolCallDelta.function?.name) block.name = toolCallDelta.function.name;

          const argsDelta = toolCallDelta.function?.arguments ?? "";
          if (argsDelta.length > 0) {
            const partialArgs =
              (toolCallPartialArgsByContentIndex.get(contentIndex) ?? "") + argsDelta;
            toolCallPartialArgsByContentIndex.set(contentIndex, partialArgs);
            block.arguments = parseStreamingJson(partialArgs);
          }

          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: argsDelta,
            partial: output,
          });
        }
      }

      finishCurrentBlock();

      for (const contentIndex of new Set(toolCallContentIndexByStreamIndex.values())) {
        const block = output.content[contentIndex];
        if (!block || block.type !== "toolCall") continue;

        const partialArgs = toolCallPartialArgsByContentIndex.get(contentIndex);
        if (partialArgs) {
          block.arguments = parseStreamingJson(partialArgs);
        }

        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: block,
          partial: output,
        });
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function streamOpenAIResponsesWithUpstreamUsage(
  model: Model<"openai-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error("OpenAI-compatible API key is missing");
      }

      const client = new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
      });

      const params = buildOpenAIResponsesParams(model, context, options);
      const rawStream = await client.responses.create(
        params,
        options?.signal ? { signal: options.signal } : undefined,
      );

      let completedUsage: unknown = null;
      let completedServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined;
      async function* tappedStream(): AsyncIterable<ResponseStreamEvent> {
        for await (const event of rawStream) {
          if (event.type === "response.completed") {
            completedUsage = event.response?.usage ?? null;
            completedServiceTier = event.response?.service_tier;
          }
          yield event;
        }
      }

      stream.push({ type: "start", partial: output });
      await processResponsesStream(tappedStream(), output, stream, model, {
        serviceTier: completedServiceTier,
        applyServiceTierPricing,
      });

      if (completedUsage != null) {
        const normalizedUsage = normalizeUsageFromOpenAICompatible(model, completedUsage);
        if (normalizedUsage) {
          output.usage = normalizedUsage.usage;
          if (normalizedUsage.costSource === "estimated") {
            applyServiceTierPricing(output.usage, completedServiceTier);
          }
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function buildOpenAICompletionsParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: SimpleStreamOptions,
): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
  const compat = resolveCompat(model);
  const messages = convertMessages(model, context, compat) as ChatCompletionMessageParam[];
  const maxTokens = (model.maxTokens / 3) | 0;

  const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  };

  const tools = convertCompletionTools(context.tools);
  if (tools) params.tools = tools;

  if (model.reasoning && options?.reasoning) {
    (params as unknown as Record<string, unknown>).reasoning = {
      effort: options.reasoning,
    };
  }

  if (model.reasoning && model.baseUrl.includes("openrouter.ai")) {
    (params as unknown as Record<string, unknown>).include_reasoning = true;
  }

  if (compat.openRouterRouting) {
    (params as unknown as Record<string, unknown>).provider = compat.openRouterRouting;
  }

  return params;
}

function buildOpenAIResponsesParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): ResponseCreateParamsStreaming {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    store: false,
    max_output_tokens: (model.maxTokens / 3) | 0,
  };

  if (options?.sessionId) {
    params.prompt_cache_key = options.sessionId;
  }

  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }

  if (model.reasoning && options?.reasoning) {
    params.reasoning = {
      effort: options.reasoning,
      summary: "detailed",
    };
    params.include = ["reasoning.encrypted_content"];
  }

  return params;
}

function resolveCompat(model: Model<"openai-completions">): Required<OpenAICompletionsCompat> {
  return {
    ...DEFAULT_COMPAT,
    ...(((model as Model<"openai-completions"> & { compat?: Partial<OpenAICompletionsCompat> })
      .compat ?? {}) as Partial<OpenAICompletionsCompat>),
  };
}

function convertCompletionTools(
  tools: Tool[] | undefined,
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

function parseRawUsage(rawUsage: unknown): OpenAICompatibleUsageRaw | null {
  if (typeof rawUsage !== "object" || rawUsage == null) {
    return null;
  }

  const usage = rawUsage as OpenAICompatibleUsageRaw;
  const hasCompletionsTokens =
    toNumber(usage.prompt_tokens) !== undefined ||
    toNumber(usage.completion_tokens) !== undefined ||
    toNumber(usage.total_tokens) !== undefined;
  const hasResponsesTokens =
    toNumber(usage.input_tokens) !== undefined ||
    toNumber(usage.output_tokens) !== undefined ||
    toNumber(usage.total_tokens) !== undefined;

  return hasCompletionsTokens || hasResponsesTokens ? usage : null;
}

function extractTokenBreakdown(rawUsage: OpenAICompatibleUsageRaw): TokenBreakdown {
  const promptTokens = toNumber(rawUsage.prompt_tokens);
  const inputTokens = toNumber(rawUsage.input_tokens);

  if (promptTokens !== undefined || toNumber(rawUsage.completion_tokens) !== undefined) {
    const completionTokens = toNumber(rawUsage.completion_tokens) ?? 0;
    const cachedTokens = toNumber(rawUsage.prompt_tokens_details?.cached_tokens) ?? 0;
    const cacheWriteTokens = toNumber(rawUsage.prompt_tokens_details?.cache_write_tokens) ?? 0;
    const reasoningTokens = toNumber(rawUsage.completion_tokens_details?.reasoning_tokens) ?? 0;
    const input = Math.max(0, (promptTokens ?? 0) - cachedTokens - cacheWriteTokens);
    const output = completionTokens + reasoningTokens;
    const totalTokens =
      toNumber(rawUsage.total_tokens) ?? input + output + cachedTokens + cacheWriteTokens;

    return {
      input,
      output,
      cacheRead: cachedTokens,
      cacheWrite: cacheWriteTokens,
      totalTokens,
      reasoningTokens,
    };
  }

  const outputTokens = toNumber(rawUsage.output_tokens) ?? 0;
  const cachedTokens = toNumber(rawUsage.input_tokens_details?.cached_tokens) ?? 0;
  const cacheWriteTokens = toNumber(rawUsage.input_tokens_details?.cache_write_tokens) ?? 0;
  const reasoningTokens = toNumber(rawUsage.output_tokens_details?.reasoning_tokens) ?? 0;
  const input = Math.max(0, (inputTokens ?? 0) - cachedTokens - cacheWriteTokens);
  const totalTokens =
    toNumber(rawUsage.total_tokens) ?? input + outputTokens + cachedTokens + cacheWriteTokens;

  return {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens,
    reasoningTokens,
  };
}

function estimateCost(model: CostedModel, usage: TokenBreakdown): Usage["cost"] {
  const input = (model.cost.input / 1_000_000) * usage.input;
  const output = (model.cost.output / 1_000_000) * usage.output;
  const cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  const cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

function resolveActualCost(
  model: Pick<Model<Api>, "baseUrl">,
  rawUsage: OpenAICompatibleUsageRaw,
): ParsedActualCost | null {
  for (const parser of COST_PARSERS) {
    if (!parser.supports(model)) continue;
    const parsed = parser.parse(rawUsage);
    if (parsed) return parsed;
  }

  return null;
}

function buildUsage(tokens: TokenBreakdown, cost: Usage["cost"]): Usage {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    totalTokens: tokens.totalTokens,
    cost,
  };
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value == null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function mapCompletionStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

function getServiceTierCostMultiplier(
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
) {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
