/**
 * pi-ai bridge used by AgentLoop and compaction runner.
 *
 * Adapts local runtime message/tool formats to pi-ai model APIs, handles
 * streaming/completion execution, and normalizes usage + errors back into local
 * runtime contracts.
 */
import {
  type Api,
  type AssistantMessage,
  completeSimple,
  type Model,
  type Tool,
  Type,
} from "@mariozechner/pi-ai";
import type {
  CompactionModelRunner,
  CompactionModelRunnerInput,
  CompactionModelRunnerResult,
} from "@/src/agent/compaction.js";
import { normalizeAgentLlmError } from "@/src/agent/llm/errors.js";
import { type AgentAssistantContentBlock, buildPiMessages } from "@/src/agent/llm/messages.js";
import { isGptFamilyResolvedModel } from "@/src/agent/llm/model-family.js";
import type { ResolvedModel, ResolvedProvider } from "@/src/agent/llm/models.js";
import { streamWithNormalizedUpstreamUsage } from "@/src/agent/llm/upstream-openai.js";
import type {
  AgentModelRunner,
  AgentModelTurnInput,
  AgentModelTurnResult,
} from "@/src/agent/loop.js";
import { filterVisibleToolsForSession } from "@/src/agent/session-policy.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";
import type { ToolRegistry } from "@/src/tools/core/registry.js";

const COMPACTION_SUMMARY_PREFIX = "[Context Summary]";
const PERMISSIVE_TOOL_PARAMETERS = Type.Object({}, { additionalProperties: true });
const DEFAULT_REASONING_LEVEL = "medium";
const logger = createSubsystemLogger("llm-bridge");
const LOG_PREVIEW_LIMIT = 160;
const OPENAI_COMPAT_ROLE_OVERRIDE = {
  supportsDeveloperRole: false,
} as const;

export interface PiBridgeTextDelta {
  delta: string;
  accumulatedText: string;
}

export interface PiBridgeThinkingDelta {
  delta: string;
}

export interface PiBridgeRunTurnInput {
  model: ResolvedModel;
  systemPrompt?: string;
  compactSummary: string | null;
  messages: Message[];
  resolveRuntimeImages?: AgentModelTurnInput["resolveRuntimeImages"];
  tools: ToolRegistry;
  sessionPurpose?: string;
  agentKind?: string | null;
  signal: AbortSignal;
  onTextDelta?: (event: PiBridgeTextDelta) => void;
  onThinkingDelta?: (event: PiBridgeThinkingDelta) => void;
}

export interface PiBridgeRunTurnResult {
  provider: string;
  model: string;
  modelApi: string;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  content: AgentAssistantContentBlock[];
  usage: MessageUsage;
  errorMessage?: string;
}

export interface ProviderApiKeyResolver {
  resolveApiKey(provider: ResolvedProvider): Promise<string | undefined>;
}

export class PiBridge {
  constructor(private readonly providerApiKeyResolver?: ProviderApiKeyResolver) {}

  async streamTurn(input: PiBridgeRunTurnInput): Promise<PiBridgeRunTurnResult> {
    // The bridge is intentionally thin: it translates our stored/session state
    // into pi input, forwards the streaming events we care about, and returns a
    // normalized assistant result that the rest of the app can persist directly.
    const model = toPiModel(input.model);
    const tools = input.model.supportsTools
      ? buildPiTools(input.tools, input.sessionPurpose, input.agentKind)
      : null;
    const context = {
      ...(input.systemPrompt == null ? {} : { systemPrompt: input.systemPrompt }),
      messages: buildPiContextMessages(
        input.compactSummary,
        input.messages,
        input.model.supportsVision,
        input.resolveRuntimeImages,
      ),
    };
    if (tools != null) {
      Object.assign(context, { tools });
    }

    logger.debug("starting streaming llm turn", {
      modelId: input.model.id,
      provider: input.model.provider.id,
      messageCount: input.messages.length,
      tools: tools?.length ?? 0,
      hasCompactSummary: input.compactSummary != null && input.compactSummary.trim().length > 0,
      hasResolveRuntimeImages: input.resolveRuntimeImages != null,
      supportsVision: input.model.supportsVision,
    });

    try {
      const stream = streamWithNormalizedUpstreamUsage(
        model,
        context,
        await buildPiStreamOptions(this.providerApiKeyResolver, input.model, input.signal, {
          enableReasoning: true,
        }),
      );
      let accumulatedText = "";
      for await (const event of stream) {
        switch (event.type) {
          case "text_delta":
            accumulatedText += event.delta;
            input.onTextDelta?.({
              delta: event.delta,
              accumulatedText,
            });
            break;
          case "thinking_delta":
            input.onThinkingDelta?.({
              delta: event.delta,
            });
            break;
          default:
            break;
        }
      }

      const finalMessage = await stream.result();
      const contentSummary = summarizeAssistantContent(finalMessage.content);
      logger.debug("streaming llm turn finished", {
        modelId: input.model.id,
        provider: input.model.provider.id,
        stopReason: finalMessage.stopReason,
        ...contentSummary,
      });
      return normalizeAssistantResult(finalMessage, "stream");
    } catch (error) {
      logRawLlmFailure("stream", input.model, error);
      throw normalizeAgentLlmError({
        error,
        provider: input.model.provider.id,
        model: input.model.id,
      });
    }
  }

  async completeTurn(
    input: Omit<PiBridgeRunTurnInput, "onTextDelta">,
  ): Promise<PiBridgeRunTurnResult> {
    const model = toPiModel(input.model);
    const tools = input.model.supportsTools
      ? buildPiTools(input.tools, input.sessionPurpose, input.agentKind)
      : null;
    const context = {
      ...(input.systemPrompt == null ? {} : { systemPrompt: input.systemPrompt }),
      messages: buildPiContextMessages(
        input.compactSummary,
        input.messages,
        input.model.supportsVision,
        input.resolveRuntimeImages,
      ),
    };
    if (tools != null) {
      Object.assign(context, { tools });
    }

    logger.debug("starting non-stream llm turn", {
      modelId: input.model.id,
      provider: input.model.provider.id,
      messageCount: input.messages.length,
      tools: tools?.length ?? 0,
      hasCompactSummary: input.compactSummary != null && input.compactSummary.trim().length > 0,
    });

    try {
      const finalMessage = await completeSimple(
        model,
        context,
        await buildPiStreamOptions(this.providerApiKeyResolver, input.model, input.signal, {
          enableReasoning: true,
        }),
      );
      const contentSummary = summarizeAssistantContent(finalMessage.content);
      logger.debug("non-stream llm turn finished", {
        modelId: input.model.id,
        provider: input.model.provider.id,
        stopReason: finalMessage.stopReason,
        ...contentSummary,
      });
      return normalizeAssistantResult(finalMessage, "complete");
    } catch (error) {
      logRawLlmFailure("complete", input.model, error);
      throw normalizeAgentLlmError({
        error,
        provider: input.model.provider.id,
        model: input.model.id,
      });
    }
  }

  async completeText(input: CompactionModelRunnerInput): Promise<CompactionModelRunnerResult> {
    const model = toPiModel(input.model);

    logger.debug("starting compaction llm call", {
      modelId: input.model.id,
      provider: input.model.provider.id,
    });

    try {
      const finalMessage = await completeSimple(
        model,
        {
          systemPrompt: input.systemPrompt,
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: input.prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        await buildPiStreamOptions(
          this.providerApiKeyResolver,
          input.model,
          input.signal ?? new AbortController().signal,
          {
            enableReasoning: false,
          },
        ),
      );

      const normalized = normalizeAssistantResult(finalMessage, "complete");
      logger.debug("compaction llm call finished", {
        modelId: input.model.id,
        provider: input.model.provider.id,
        outputTokens: normalized.usage.output,
      });
      return {
        provider: normalized.provider,
        model: normalized.model,
        modelApi: normalized.modelApi,
        text: normalized.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .trim(),
        usage: normalized.usage,
      };
    } catch (error) {
      logRawLlmFailure("compaction", input.model, error);
      throw normalizeAgentLlmError({
        error,
        provider: input.model.provider.id,
        model: input.model.id,
      });
    }
  }
}

export class PiAgentModelRunner implements AgentModelRunner, CompactionModelRunner {
  constructor(
    private readonly bridge: PiBridge,
    private readonly tools: ToolRegistry,
  ) {}

  runTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult> {
    return this.bridge.streamTurn({
      model: input.model,
      ...(input.systemPrompt == null ? {} : { systemPrompt: input.systemPrompt }),
      compactSummary: input.compactSummary,
      messages: input.messages,
      ...(input.resolveRuntimeImages == null
        ? {}
        : { resolveRuntimeImages: input.resolveRuntimeImages }),
      ...(input.sessionPurpose == null ? {} : { sessionPurpose: input.sessionPurpose }),
      ...(input.agentKind === undefined ? {} : { agentKind: input.agentKind }),
      tools: this.tools,
      signal: input.signal,
      ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
      ...(input.onThinkingDelta ? { onThinkingDelta: input.onThinkingDelta } : {}),
    });
  }

  runCompaction(input: CompactionModelRunnerInput): Promise<CompactionModelRunnerResult> {
    return this.bridge.completeText(input);
  }
}

function buildPiContextMessages(
  compactSummary: string | null,
  messages: Message[],
  supportsVision: boolean,
  resolveRuntimeImages?: AgentModelTurnInput["resolveRuntimeImages"],
) {
  const piMessages = buildPiMessages(messages, {
    supportsVision,
    ...(resolveRuntimeImages == null
      ? {}
      : { resolveRuntimeImages: (message, _images) => resolveRuntimeImages(message) }),
  });
  logger.debug("built pi context messages", {
    storedMessageCount: messages.length,
    piMessageCount: piMessages.length,
    supportsVision,
    hasCompactSummary: compactSummary != null && compactSummary.trim().length > 0,
    hasResolveRuntimeImagesCallback: resolveRuntimeImages != null,
  });
  if (compactSummary == null || compactSummary.trim().length === 0) {
    return piMessages;
  }

  // Compacted history is reintroduced as a synthetic user message for now.
  // This keeps the bridge simple while the session-level compaction state still
  // lives outside the raw message transcript.
  return [
    {
      role: "user" as const,
      content: `${COMPACTION_SUMMARY_PREFIX}\n${compactSummary}`,
      timestamp: Date.now(),
    },
    ...piMessages,
  ];
}

function buildPiTools(
  registry: ToolRegistry,
  sessionPurpose?: string,
  agentKind?: string | null,
): Tool[] {
  // We expose the tool schema to pi for tool selection, but actual execution
  // still happens in our loop after pi emits toolCall blocks.
  const visibleTools = filterVisibleToolsForSession(registry.list(), {
    purpose: sessionPurpose ?? "",
    ...(agentKind === undefined ? {} : { agentKind }),
  });

  return visibleTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: isObject(tool.inputSchema)
      ? (tool.inputSchema as Tool["parameters"])
      : PERMISSIVE_TOOL_PARAMETERS,
  }));
}

async function buildPiStreamOptions(
  providerApiKeyResolver: ProviderApiKeyResolver | undefined,
  model: ResolvedModel,
  signal: AbortSignal,
  input: {
    enableReasoning: boolean;
  },
) {
  const options: {
    signal: AbortSignal;
    sessionId: string;
    apiKey?: string;
    reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  } = {
    signal,
    sessionId: model.id,
  };
  const apiKey =
    (await providerApiKeyResolver?.resolveApiKey(model.provider)) ??
    model.provider.apiKey ??
    undefined;
  if (apiKey != null) {
    Object.assign(options, {
      apiKey,
    });
  }

  if (input.enableReasoning && model.reasoning?.enabled) {
    options.reasoning = model.reasoning.effort ?? DEFAULT_REASONING_LEVEL;
  }

  return options;
}

function toPiModel(model: ResolvedModel): Model<Api> {
  const api = resolvePiApi(model);
  const compat = isOpenAICompatibleApi(api) ? OPENAI_COMPAT_ROLE_OVERRIDE : null;

  return {
    id: model.upstreamId,
    name: model.id,
    api,
    provider: model.provider.id,
    baseUrl: resolvePiBaseUrl(model),
    reasoning: model.reasoning?.enabled === true,
    input: model.supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: model.pricing?.input ?? 0,
      output: model.pricing?.output ?? 0,
      cacheRead: model.pricing?.cacheRead ?? 0,
      cacheWrite: model.pricing?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens,
    ...(compat == null ? {} : { compat }),
  };
}

function resolvePiApi(model: ResolvedModel): Api {
  if (shouldUseOpenAICompletions(model)) {
    return "openai-completions";
  }

  return model.provider.api as Api;
}

function shouldUseOpenAICompletions(model: ResolvedModel): boolean {
  if (model.provider.api !== "openai-responses") {
    return false;
  }

  return !isGptFamilyResolvedModel(model);
}

function isOpenAICompatibleApi(api: Api): api is "openai-completions" | "openai-responses" {
  return api === "openai-completions" || api === "openai-responses";
}

function resolvePiBaseUrl(model: ResolvedModel): string {
  if (model.provider.baseUrl) {
    return model.provider.baseUrl;
  }

  switch (model.provider.api) {
    case "anthropic-messages":
      return "https://api.anthropic.com";
    case "openai-completions":
    case "openai-responses":
      return "https://api.openai.com/v1";
    case "openai-codex-responses":
      return "https://chatgpt.com/backend-api";
    case "google-generative-ai":
      return "https://generativelanguage.googleapis.com";
    default:
      throw new Error(
        `Provider "${model.provider.id}" is missing baseUrl for api "${model.provider.api}"`,
      );
  }
}

function normalizeUsage(message: { usage: AssistantMessage["usage"] }): MessageUsage {
  return {
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    cost: {
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cacheRead: message.usage.cost.cacheRead,
      cacheWrite: message.usage.cost.cacheWrite,
      total: message.usage.cost.total,
    },
  };
}

function normalizeAssistantResult(
  message: AssistantMessage,
  mode: "stream" | "complete",
): PiBridgeRunTurnResult {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw normalizeAgentLlmError({
      error: message.errorMessage ?? `pi ${mode} failed with stopReason=${message.stopReason}`,
      provider: message.provider,
      model: message.model,
    });
  }

  return {
    provider: message.provider,
    model: message.model,
    modelApi: message.api,
    stopReason: message.stopReason,
    content: message.content as AgentAssistantContentBlock[],
    usage: normalizeUsage(message),
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
  };
}

interface AssistantContentSummary {
  blockTypes: string;
  textBlocks: number;
  textChars: number;
  textPreview?: string;
  thinkingBlocks: number;
  thinkingChars: number;
  thinkingPreview?: string;
  toolCallBlocks: number;
  toolCallNames?: string;
}

function summarizeAssistantContent(content: AssistantMessage["content"]): AssistantContentSummary {
  const blockTypes: string[] = [];
  const toolCallNames: string[] = [];
  let textBlocks = 0;
  let textChars = 0;
  let textPreview: string | undefined;
  let thinkingBlocks = 0;
  let thinkingChars = 0;
  let thinkingPreview: string | undefined;
  let toolCallBlocks = 0;

  for (const block of content) {
    blockTypes.push(block.type);
    switch (block.type) {
      case "text":
        textBlocks += 1;
        textChars += block.text.length;
        textPreview ??= truncateForLog(block.text);
        break;
      case "thinking":
        thinkingBlocks += 1;
        thinkingChars += block.thinking.length;
        thinkingPreview ??= truncateForLog(block.thinking);
        break;
      case "toolCall":
        toolCallBlocks += 1;
        if (block.name.length > 0) {
          toolCallNames.push(block.name);
        }
        break;
      default:
        break;
    }
  }

  return {
    blockTypes: blockTypes.join(","),
    textBlocks,
    textChars,
    ...(textPreview == null ? {} : { textPreview }),
    thinkingBlocks,
    thinkingChars,
    ...(thinkingPreview == null ? {} : { thinkingPreview }),
    toolCallBlocks,
    ...(toolCallNames.length === 0 ? {} : { toolCallNames: toolCallNames.join(",") }),
  };
}

function logRawLlmFailure(
  phase: "stream" | "complete" | "compaction",
  model: ResolvedModel,
  error: unknown,
): void {
  logger.error("raw llm failure before normalization", {
    phase,
    provider: model.provider.id,
    providerApi: model.provider.api,
    modelId: model.id,
    upstreamModelId: model.upstreamId,
    ...summarizeRawLlmError(error),
  });
}

function summarizeRawLlmError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const cause = error.cause;
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(typeof error.stack === "string"
        ? { stackTop: error.stack.split("\n").slice(0, 3).join(" | ") }
        : {}),
      ...(readErrorNumberField(error, ["status"]) === undefined
        ? {}
        : { status: readErrorNumberField(error, ["status"]) }),
      ...(readErrorNumberField(error, ["statusCode"]) === undefined
        ? {}
        : { statusCode: readErrorNumberField(error, ["statusCode"]) }),
      ...(readErrorNumberField(error, ["response", "status"]) === undefined
        ? {}
        : { responseStatus: readErrorNumberField(error, ["response", "status"]) }),
      ...(readErrorStringField(error, ["code"]) == null
        ? {}
        : { code: readErrorStringField(error, ["code"]) }),
      ...(cause instanceof Error
        ? {
            causeName: cause.name,
            causeMessage: cause.message,
            ...(typeof cause.stack === "string"
              ? { causeStackTop: cause.stack.split("\n").slice(0, 3).join(" | ") }
              : {}),
          }
        : typeof cause === "object" && cause != null
          ? {
              cause: cause,
            }
          : cause == null
            ? {}
            : { cause }),
    };
  }

  return { errorValue: error };
}

function readErrorNumberField(value: unknown, path: string[]): number | undefined {
  const candidate = readErrorField(value, path);
  return typeof candidate === "number" ? candidate : undefined;
}

function readErrorStringField(value: unknown, path: string[]): string | undefined {
  const candidate = readErrorField(value, path);
  return typeof candidate === "string" ? candidate : undefined;
}

function readErrorField(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current == null || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function truncateForLog(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length <= LOG_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, LOG_PREVIEW_LIMIT)}...`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
