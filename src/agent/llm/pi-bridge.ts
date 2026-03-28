import {
  type Api,
  type AssistantMessage,
  completeSimple,
  type Model,
  streamSimple,
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
import type { ResolvedModel } from "@/src/agent/llm/models.js";
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

export class PiBridge {
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
      messages: buildPiContextMessages(input.compactSummary, input.messages),
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
    });
    // logLlmRequestContext("stream", input, context.messages, tools);

    try {
      const stream = streamSimple(
        model,
        context,
        buildPiStreamOptions(input.model, input.signal, { enableReasoning: true }),
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
      logger.debug("streaming llm turn finished", {
        modelId: input.model.id,
        provider: input.model.provider.id,
        stopReason: finalMessage.stopReason,
      });
      return normalizeAssistantResult(finalMessage, "stream");
    } catch (error) {
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
      messages: buildPiContextMessages(input.compactSummary, input.messages),
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
    // logLlmRequestContext("complete", input, context.messages, tools);

    try {
      const finalMessage = await completeSimple(
        model,
        context,
        buildPiStreamOptions(input.model, input.signal, { enableReasoning: true }),
      );
      logger.debug("non-stream llm turn finished", {
        modelId: input.model.id,
        provider: input.model.provider.id,
        stopReason: finalMessage.stopReason,
      });
      return normalizeAssistantResult(finalMessage, "complete");
    } catch (error) {
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
        buildPiStreamOptions(input.model, input.signal ?? new AbortController().signal, {
          enableReasoning: false,
        }),
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

function buildPiContextMessages(compactSummary: string | null, messages: Message[]) {
  const piMessages = buildPiMessages(messages);
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

function buildPiStreamOptions(
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
  if (model.provider.apiKey != null) {
    Object.assign(options, {
      apiKey: model.provider.apiKey,
    });
  }

  if (input.enableReasoning && model.supportsReasoning) {
    options.reasoning = DEFAULT_REASONING_LEVEL;
  }

  return options;
}

function toPiModel(model: ResolvedModel): Model<Api> {
  return {
    id: model.upstreamId,
    name: model.id,
    api: resolvePiApi(model),
    provider: model.provider.id,
    baseUrl: resolvePiBaseUrl(model),
    reasoning: model.supportsReasoning,
    input: model.supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: model.pricing?.input ?? 0,
      output: model.pricing?.output ?? 0,
      cacheRead: model.pricing?.cacheRead ?? 0,
      cacheWrite: model.pricing?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens,
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

  return !isGptFamilyModel(model);
}

function isGptFamilyModel(model: ResolvedModel): boolean {
  const normalizedIds = [model.id, model.upstreamId].map((value) => value.toLowerCase());
  return normalizedIds.some((value) => value.includes("gpt"));
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
    case "openai-codex-responses":
      return "https://api.openai.com/v1";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
