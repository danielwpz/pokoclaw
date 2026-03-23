import { randomUUID } from "node:crypto";

import { type AgentLlmErrorKind, isAgentLlmError } from "@/src/agent/llm/errors.js";
import type {
  AgentAssistantPayload,
  AgentToolResultContentBlock,
  AgentToolResultPayload,
  AgentUserPayload,
} from "@/src/agent/llm/messages.js";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AgentSessionService } from "@/src/agent/session.js";
import type { CompactionConfig } from "@/src/config/schema.js";
import { createBootstrapLogger, createLogger, type Logger } from "@/src/shared/logger.js";
import type { MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant for a personal AI agent runtime. " +
  "Read the provided conversation transcript and output only a structured checkpoint summary. " +
  "Do not continue the conversation or answer the user.";

const INITIAL_SUMMARIZATION_PROMPT = `Summarize the conversation in this EXACT structure:

## Current Objective
[What the agent is currently trying to accomplish]

## Latest User Intent
[The user's most recent concrete ask or direction]

## Progress / Current State
- [Completed work, current status, and any ongoing work]

## Important Decisions & Constraints
- [Decisions, requirements, preferences, boundaries, permissions]

## Critical Context
- [Exact identifiers, URLs, file paths, names, timestamps, errors, facts needed to continue]

## Next Steps
1. [What should happen next]

Keep it concise. Preserve exact identifiers when they matter.`;

const UPDATE_SUMMARIZATION_PROMPT = `Update the existing checkpoint summary with the new conversation content.

Rules:
- Preserve still-relevant information from the previous summary.
- Update progress and next steps to reflect newly completed or changed work.
- Preserve exact identifiers, URLs, file paths, names, timestamps, and errors when they matter.
- Remove stale items if the new conversation clearly supersedes them.

Use the same EXACT structure as the previous summary.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This transcript is the PREFIX of a turn that was too large to keep in full. The more recent suffix will remain as raw history.

Summarize only what is needed so another model can understand the retained suffix.

Use this EXACT structure:

## Original Request
[What the user was asking in this turn]

## Early Progress
- [Important work already done before the retained suffix]

## Context for Retained Suffix
- [Facts needed to understand the kept suffix]

Keep it concise.`;

const TOOL_RESULT_MAX_CHARS = 2_000;
const EMPTY_SUMMARY_FALLBACK = "No prior context.";

export type CompactionReason = "threshold" | "overflow";

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: CompactionReason | null;
  effectiveWindow: number;
  thresholdTokens: number;
}

export interface DecideCompactionInput {
  contextTokens: number;
  contextWindow: number;
  config: CompactionConfig;
  overflow?: boolean;
}

export interface SessionContextTokenEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
  compactSummaryTokens: number;
}

export interface CompactionPreparation {
  firstKeptIndex: number;
  isSplitTurn: boolean;
  turnStartIndex: number;
  messagesToSummarize: Message[];
  turnPrefixMessages: Message[];
  compactCursor: number;
}

export interface CompactionModelRunnerInput {
  model: ResolvedModel;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface CompactionModelRunnerResult {
  provider: string;
  model: string;
  modelApi: string;
  text: string;
  usage: MessageUsage;
}

export interface CompactionModelRunner {
  runCompaction(input: CompactionModelRunnerInput): Promise<CompactionModelRunnerResult>;
}

export type CompactionLifecycleEventInput =
  | {
      type: "compaction_started";
      reason: CompactionReason;
      modelId: string;
      sessionId: string;
      conversationId: string;
      branchId: string;
      runId: string;
    }
  | {
      type: "compaction_completed";
      reason: CompactionReason;
      modelId: string;
      compacted: boolean;
      compactCursor: number;
      summaryTokenTotal: number | null;
      sessionId: string;
      conversationId: string;
      branchId: string;
      runId: string;
    }
  | {
      type: "compaction_failed";
      reason: CompactionReason;
      modelId: string;
      errorKind: AgentLlmErrorKind | "unknown";
      errorMessage: string;
      retryable: boolean;
      sessionId: string;
      conversationId: string;
      branchId: string;
      runId: string;
    };

export interface AgentCompactionServiceDependencies {
  sessions: AgentSessionService;
  models: ProviderRegistry;
  runner: CompactionModelRunner;
  config: CompactionConfig;
}

export interface AgentCompactionInput {
  sessionId: string;
  conversationId: string;
  branchId: string;
  runId: string;
  reason: CompactionReason;
  signal?: AbortSignal;
  emitEvent?: (event: CompactionLifecycleEventInput) => void;
}

export interface AgentCompactionResult {
  compacted: boolean;
  compactCursor: number;
  summaryTokenTotal: number | null;
}

export function getEffectiveCompactionWindow(contextWindow: number): number {
  return contextWindow;
}

export function getCompactionThresholdTokens(
  contextWindow: number,
  config: CompactionConfig,
): number {
  const reserveTokens = Math.max(config.reserveTokens, config.reserveTokensFloor);
  return Math.max(0, getEffectiveCompactionWindow(contextWindow) - reserveTokens);
}

export function decideCompaction(input: DecideCompactionInput): CompactionDecision {
  const thresholdTokens = getCompactionThresholdTokens(input.contextWindow, input.config);
  const effectiveWindow = getEffectiveCompactionWindow(input.contextWindow);

  if (input.overflow === true) {
    return {
      shouldCompact: true,
      reason: "overflow",
      effectiveWindow,
      thresholdTokens,
    };
  }

  if (input.contextTokens >= thresholdTokens) {
    return {
      shouldCompact: true,
      reason: "threshold",
      effectiveWindow,
      thresholdTokens,
    };
  }

  return {
    shouldCompact: false,
    reason: null,
    effectiveWindow,
    thresholdTokens,
  };
}

export function estimateSessionContextTokens(input: {
  compactSummary: string | null;
  compactSummaryTokenTotal: number | null;
  compactSummaryUsageJson?: string | null;
  messages: Message[];
}): SessionContextTokenEstimate {
  const compactSummaryTokens = estimateCompactSummaryTokens(
    input.compactSummary,
    input.compactSummaryTokenTotal,
    input.compactSummaryUsageJson,
  );
  const lastUsageIndex = findLastAssistantUsageIndex(input.messages);

  if (lastUsageIndex == null) {
    let total = compactSummaryTokens;
    for (const message of input.messages) {
      total += estimateStoredMessageTokens(message);
    }

    return {
      tokens: total,
      usageTokens: 0,
      trailingTokens: total - compactSummaryTokens,
      lastUsageIndex: null,
      compactSummaryTokens,
    };
  }

  const usageMessage = input.messages[lastUsageIndex];
  if (usageMessage == null) {
    throw new Error(`Missing usage message at index ${lastUsageIndex}`);
  }
  const usageTokens = getRequiredMessageTokenTotal(usageMessage);
  let trailingTokens = 0;
  for (let index = lastUsageIndex + 1; index < input.messages.length; index += 1) {
    const trailingMessage = input.messages[index];
    if (trailingMessage == null) {
      continue;
    }
    trailingTokens += estimateStoredMessageTokens(trailingMessage);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
    compactSummaryTokens,
  };
}

export function prepareCompaction(input: {
  messages: Message[];
  config: CompactionConfig;
  contextTokens: number;
}): CompactionPreparation | null {
  if (input.messages.length === 0) {
    return null;
  }

  const fullTurnIndex = findFullTurnCutPoint(input.messages, input.config);
  if (fullTurnIndex > 0) {
    return {
      firstKeptIndex: fullTurnIndex,
      isSplitTurn: false,
      turnStartIndex: -1,
      messagesToSummarize: input.messages.slice(0, fullTurnIndex),
      turnPrefixMessages: [],
      compactCursor: input.messages[fullTurnIndex - 1]?.seq ?? 0,
    };
  }

  const splitCut = findSplitTurnCutPoint(input.messages, input.config);
  if (splitCut != null) {
    const turnStartIndex = findTurnStartIndex(input.messages, splitCut);
    if (turnStartIndex >= 0) {
      return {
        firstKeptIndex: splitCut,
        isSplitTurn: true,
        turnStartIndex,
        messagesToSummarize: input.messages.slice(0, turnStartIndex),
        turnPrefixMessages: input.messages.slice(turnStartIndex, splitCut),
        compactCursor: input.messages[splitCut - 1]?.seq ?? 0,
      };
    }
  }

  if (input.contextTokens > 0) {
    return {
      firstKeptIndex: input.messages.length,
      isSplitTurn: false,
      turnStartIndex: -1,
      messagesToSummarize: [...input.messages],
      turnPrefixMessages: [],
      compactCursor: input.messages.at(-1)?.seq ?? 0,
    };
  }

  return null;
}

export class AgentCompactionService {
  private readonly inflight = new Map<string, Promise<AgentCompactionResult>>();
  private loggerPromise: Promise<Logger> | null = null;

  constructor(private readonly deps: AgentCompactionServiceDependencies) {}

  schedule(input: AgentCompactionInput): Promise<AgentCompactionResult> {
    void this.log("debug", "Queued a background compaction pass", {
      sessionId: input.sessionId,
      reason: input.reason,
      runId: input.runId,
    });
    const promise = this.compactNow(input);
    void promise.catch((error) => {
      void this.log("warn", "Background compaction did not finish cleanly", {
        sessionId: input.sessionId,
        reason: input.reason,
        error: getErrorMessage(error),
      });
    });
    return promise;
  }

  compactNow(input: AgentCompactionInput): Promise<AgentCompactionResult> {
    const existing = this.inflight.get(input.sessionId);
    if (existing != null) {
      void this.log("debug", "Compaction is already running for this session; reusing it", {
        sessionId: input.sessionId,
        reason: input.reason,
        runId: input.runId,
      });
      return existing;
    }

    const promise = this.execute(input).finally(() => {
      this.inflight.delete(input.sessionId);
    });
    this.inflight.set(input.sessionId, promise);
    return promise;
  }

  private async execute(input: AgentCompactionInput): Promise<AgentCompactionResult> {
    const model = this.deps.models.getRequiredScenarioModel("compaction");
    const logger = await this.getLogger();
    logger.info("Starting a compaction pass", {
      sessionId: input.sessionId,
      reason: input.reason,
      modelId: model.id,
      runId: input.runId,
    });
    input.emitEvent?.({
      type: "compaction_started",
      reason: input.reason,
      modelId: model.id,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      runId: input.runId,
    });

    try {
      const context = this.deps.sessions.getContext(input.sessionId);
      const contextEstimate = estimateSessionContextTokens({
        compactSummary: context.compactSummary,
        compactSummaryTokenTotal: context.compactSummaryTokenTotal,
        compactSummaryUsageJson: context.compactSummaryUsageJson,
        messages: context.messages,
      });
      const preparation = prepareCompaction({
        messages: context.messages,
        config: this.deps.config,
        contextTokens: contextEstimate.tokens,
      });
      logger.debug("Compaction context is ready", {
        sessionId: input.sessionId,
        reason: input.reason,
        contextTokens: contextEstimate.tokens,
        compactSummaryTokens: contextEstimate.compactSummaryTokens,
        lastUsageIndex: contextEstimate.lastUsageIndex,
        messageCount: context.messages.length,
        splitTurn: preparation?.isSplitTurn ?? false,
        messagesToSummarize: preparation?.messagesToSummarize.length ?? 0,
        retainedTurnPrefixMessages: preparation?.turnPrefixMessages.length ?? 0,
      });

      if (preparation == null) {
        const compactCursor = context.session.compactCursor;
        const summaryTokenTotal = context.compactSummaryTokenTotal;
        logger.info("Skipped compaction because there was nothing older to fold in", {
          sessionId: input.sessionId,
          reason: input.reason,
          compactCursor,
          summaryTokenTotal,
        });
        input.emitEvent?.({
          type: "compaction_completed",
          reason: input.reason,
          modelId: model.id,
          compacted: false,
          compactCursor,
          summaryTokenTotal,
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          branchId: input.branchId,
          runId: input.runId,
        });
        return {
          compacted: false,
          compactCursor,
          summaryTokenTotal,
        };
      }

      logger.debug("Generating the new compact summary", {
        sessionId: input.sessionId,
        reason: input.reason,
        compactCursor: preparation.compactCursor,
        splitTurn: preparation.isSplitTurn,
        summarizedMessages: preparation.messagesToSummarize.length,
        retainedTurnPrefixMessages: preparation.turnPrefixMessages.length,
      });
      const summaryResult = await this.generateSummary({
        model,
        previousSummary: context.compactSummary ?? undefined,
        messagesToSummarize: preparation.messagesToSummarize,
        turnPrefixMessages: preparation.turnPrefixMessages,
        signal: input.signal,
      });

      this.deps.sessions.updateCompaction({
        id: input.sessionId,
        compactCursor: preparation.compactCursor,
        compactSummary: summaryResult.text,
        // Store the summary text token count itself, not the full API total.
        compactSummaryTokenTotal: summaryResult.usage.output,
        compactSummaryUsageJson: JSON.stringify(summaryResult.usage),
        updatedAt: new Date(),
      });
      logger.info("Finished compaction and saved the new summary", {
        sessionId: input.sessionId,
        reason: input.reason,
        compactCursor: preparation.compactCursor,
        summaryTokenTotal: summaryResult.usage.output,
        splitTurn: preparation.isSplitTurn,
      });

      input.emitEvent?.({
        type: "compaction_completed",
        reason: input.reason,
        modelId: model.id,
        compacted: true,
        compactCursor: preparation.compactCursor,
        summaryTokenTotal: summaryResult.usage.output,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        branchId: input.branchId,
        runId: input.runId,
      });

      return {
        compacted: true,
        compactCursor: preparation.compactCursor,
        summaryTokenTotal: summaryResult.usage.output,
      };
    } catch (error) {
      logger.warn("Compaction failed", {
        sessionId: input.sessionId,
        reason: input.reason,
        modelId: model.id,
        error: getErrorMessage(error),
      });
      input.emitEvent?.({
        type: "compaction_failed",
        reason: input.reason,
        modelId: model.id,
        errorKind: isAgentLlmError(error) ? error.kind : "unknown",
        errorMessage: getErrorMessage(error),
        retryable: isAgentLlmError(error) ? error.retryable : false,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        branchId: input.branchId,
        runId: input.runId,
      });
      throw error;
    }
  }

  private async getLogger(): Promise<Logger> {
    this.loggerPromise ??= createLogger({ subsystem: "compaction" });

    try {
      return await this.loggerPromise;
    } catch {
      return createBootstrapLogger({ subsystem: "compaction" });
    }
  }

  private async log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const logger = await this.getLogger();
    logger[level](message, context);
  }

  private async generateSummary(input: {
    model: ResolvedModel;
    previousSummary: string | undefined;
    messagesToSummarize: Message[];
    turnPrefixMessages: Message[];
    signal: AbortSignal | undefined;
  }): Promise<CompactionModelRunnerResult> {
    const summaryPrompt = buildSummarizationPrompt({
      messages: input.messagesToSummarize,
      previousSummary: input.previousSummary,
    });

    if (input.turnPrefixMessages.length === 0) {
      return await this.deps.runner.runCompaction(
        withOptionalSignal(
          {
            model: input.model,
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            prompt: summaryPrompt,
          },
          input.signal,
        ),
      );
    }

    const [historySummary, turnPrefixSummary] = await Promise.all([
      input.messagesToSummarize.length > 0
        ? this.deps.runner.runCompaction({
            ...withOptionalSignal(
              {
                model: input.model,
                systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
                prompt: summaryPrompt,
              },
              input.signal,
            ),
          })
        : Promise.resolve<CompactionModelRunnerResult>({
            provider: input.model.provider.id,
            model: input.model.id,
            modelApi: input.model.provider.api,
            text: input.previousSummary?.trim() || EMPTY_SUMMARY_FALLBACK,
            usage: {
              input: 0,
              output: input.previousSummary == null ? 0 : estimateTextTokens(input.previousSummary),
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens:
                input.previousSummary == null ? 0 : estimateTextTokens(input.previousSummary),
            },
          }),
      this.deps.runner.runCompaction(
        withOptionalSignal(
          {
            model: input.model,
            systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
            prompt: buildTurnPrefixPrompt(input.turnPrefixMessages),
          },
          input.signal,
        ),
      ),
    ]);

    const mergedText = `${historySummary.text}\n\n---\n\n## Retained Turn Context\n${turnPrefixSummary.text}`;
    return {
      provider: historySummary.provider,
      model: historySummary.model,
      modelApi: historySummary.modelApi,
      text: mergedText,
      usage: {
        input: historySummary.usage.input + turnPrefixSummary.usage.input,
        output: estimateTextTokens(mergedText),
        cacheRead: historySummary.usage.cacheRead + turnPrefixSummary.usage.cacheRead,
        cacheWrite: historySummary.usage.cacheWrite + turnPrefixSummary.usage.cacheWrite,
        totalTokens:
          historySummary.usage.input +
          turnPrefixSummary.usage.input +
          estimateTextTokens(mergedText) +
          historySummary.usage.cacheRead +
          turnPrefixSummary.usage.cacheRead +
          historySummary.usage.cacheWrite +
          turnPrefixSummary.usage.cacheWrite,
      },
    };
  }
}

function estimateCompactSummaryTokens(
  compactSummary: string | null,
  compactSummaryTokenTotal: number | null,
  compactSummaryUsageJson: string | null | undefined,
): number {
  if (compactSummaryTokenTotal != null) {
    return compactSummaryTokenTotal;
  }

  if (compactSummaryUsageJson != null) {
    try {
      const usage = JSON.parse(compactSummaryUsageJson) as Partial<MessageUsage>;
      if (typeof usage.output === "number" && Number.isFinite(usage.output) && usage.output >= 0) {
        return Math.floor(usage.output);
      }
    } catch {
      // Fall through to text estimation.
    }
  }

  if (compactSummary == null) {
    return 0;
  }

  return estimateTextTokens(compactSummary);
}

function findLastAssistantUsageIndex(messages: Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null) {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    if (getMessageTokenTotal(message) != null) {
      return index;
    }
  }

  return null;
}

function getRequiredMessageTokenTotal(message: Message): number {
  const tokenTotal = getMessageTokenTotal(message);
  if (tokenTotal == null) {
    throw new Error(`Message ${message.id} is missing tokenTotal`);
  }
  return tokenTotal;
}

function getMessageTokenTotal(message: Message): number | null {
  if (message.tokenTotal != null) {
    return message.tokenTotal;
  }

  if (message.usageJson == null) {
    return null;
  }

  try {
    const usage = JSON.parse(message.usageJson) as Partial<MessageUsage>;
    if (
      typeof usage.totalTokens === "number" &&
      Number.isFinite(usage.totalTokens) &&
      usage.totalTokens >= 0
    ) {
      return Math.floor(usage.totalTokens);
    }
  } catch {
    return null;
  }

  return null;
}

function estimateStoredMessageTokens(message: Message): number {
  const tokenTotal = getMessageTokenTotal(message);
  if (tokenTotal != null) {
    return tokenTotal;
  }

  return estimateTextTokens(serializeMessageForSummary(message));
}

function findFullTurnCutPoint(messages: Message[], config: CompactionConfig): number {
  const turnStarts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  if (turnStarts.length === 0) {
    return 0;
  }

  const recentTurnsFloorIndex = resolveRecentTurnsFloorIndex(
    turnStarts,
    config.recentTurnsPreserve,
  );
  const budgetCutIndex = findBudgetCutPoint(messages, config.keepRecentTokens, (message) => {
    return message.role === "user";
  });

  return Math.min(budgetCutIndex, recentTurnsFloorIndex);
}

function findSplitTurnCutPoint(messages: Message[], config: CompactionConfig): number | null {
  const cutIndex = findBudgetCutPoint(messages, config.keepRecentTokens, (message) => {
    return message.role === "user" || message.role === "assistant";
  });

  if (cutIndex <= 0) {
    return null;
  }

  return messages[cutIndex]?.role === "assistant" ? cutIndex : null;
}

function findBudgetCutPoint(
  messages: Message[],
  keepRecentTokens: number,
  isValidCutPoint: (message: Message) => boolean,
): number {
  const cutPoints = messages.flatMap((message, index) => (isValidCutPoint(message) ? [index] : []));
  if (cutPoints.length === 0) {
    return 0;
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0] ?? 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null) {
      continue;
    }
    accumulatedTokens += estimateStoredMessageTokens(message);
    if (accumulatedTokens < keepRecentTokens) {
      continue;
    }

    for (const candidate of cutPoints) {
      if (candidate >= index) {
        cutIndex = candidate;
        return cutIndex;
      }
    }
  }

  return cutIndex;
}

function resolveRecentTurnsFloorIndex(turnStarts: number[], recentTurnsPreserve: number): number {
  if (turnStarts.length === 0) {
    return 0;
  }

  const preserve = Math.max(1, recentTurnsPreserve);
  if (turnStarts.length <= preserve) {
    return turnStarts[0] ?? 0;
  }

  return turnStarts[turnStarts.length - preserve] ?? turnStarts[0] ?? 0;
}

function findTurnStartIndex(messages: Message[], index: number): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.role === "user") {
      return cursor;
    }
  }

  return -1;
}

function buildSummarizationPrompt(input: {
  messages: Message[];
  previousSummary: string | undefined;
}): string {
  const conversationText = serializeConversation(input.messages);
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (input.previousSummary != null && input.previousSummary.trim().length > 0) {
    prompt += `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`;
    prompt += UPDATE_SUMMARIZATION_PROMPT;
  } else {
    prompt += INITIAL_SUMMARIZATION_PROMPT;
  }
  return prompt;
}

function buildTurnPrefixPrompt(messages: Message[]): string {
  const conversationText = serializeConversation(messages);
  return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const serialized = serializeMessageForSummary(message);
    if (serialized.length > 0) {
      parts.push(serialized);
    }
  }

  return parts.join("\n\n");
}

function serializeMessageForSummary(message: Message): string {
  switch (message.role) {
    case "user":
      return serializeUserMessage(message);
    case "assistant":
      return serializeAssistantMessage(message);
    case "tool":
      return serializeToolResultMessage(message);
    default:
      return "";
  }
}

function serializeUserMessage(message: Message): string {
  const payload = parsePayload<AgentUserPayload>(message.payloadJson);
  return typeof payload.content === "string" ? `[User]: ${payload.content}` : "";
}

function serializeAssistantMessage(message: Message): string {
  const payload = parsePayload<AgentAssistantPayload>(message.payloadJson);
  if (!Array.isArray(payload.content)) {
    return "";
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of payload.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "thinking") {
      thinkingParts.push(block.thinking);
      continue;
    }

    if (block.type === "toolCall") {
      toolCalls.push(
        `${block.name}(${Object.entries(block.arguments)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ")})`,
      );
    }
  }

  const parts: string[] = [];
  if (thinkingParts.length > 0) {
    parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
  }
  if (textParts.length > 0) {
    parts.push(`[Assistant]: ${textParts.join("\n")}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
  }
  return parts.join("\n");
}

function serializeToolResultMessage(message: Message): string {
  const payload = parsePayload<AgentToolResultPayload>(message.payloadJson);
  if (!Array.isArray(payload.content)) {
    return "";
  }

  const text = payload.content
    .map((block) => serializeToolResultContentBlock(block))
    .join("\n")
    .trim();
  if (text.length === 0) {
    return "";
  }

  return `[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`;
}

function serializeToolResultContentBlock(block: AgentToolResultContentBlock): string {
  if (block.type === "text") {
    return block.text;
  }

  return JSON.stringify(block.json);
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function parsePayload<T>(payloadJson: string): T {
  return JSON.parse(payloadJson) as T;
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function withOptionalSignal(
  input: Omit<CompactionModelRunnerInput, "signal">,
  signal: AbortSignal | undefined,
): CompactionModelRunnerInput {
  if (signal == null) {
    return input;
  }

  return {
    ...input,
    signal,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

export function createCompactionEventId(): string {
  return randomUUID();
}
