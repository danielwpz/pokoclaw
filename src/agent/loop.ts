import { randomUUID } from "node:crypto";
import type { SessionRunAbortRegistry } from "@/src/agent/cancel.js";
import {
  AgentCompactionService,
  type CompactionDecision,
  type CompactionModelRunner,
  decideCompaction,
  estimateSessionContextTokens,
} from "@/src/agent/compaction.js";
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventInput,
  AgentToolCall,
} from "@/src/agent/events.js";
import { isAgentLlmError } from "@/src/agent/llm/errors.js";
import type {
  AgentAssistantContentBlock,
  AgentAssistantPayload,
  AgentToolResultPayload,
} from "@/src/agent/llm/messages.js";
import type { ModelScenario, ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AgentSessionService } from "@/src/agent/session.js";
import {
  buildToolFailureContent,
  isToolFailure,
  normalizeToolFailure,
} from "@/src/agent/tools/errors.js";
import type { ToolRegistry } from "@/src/agent/tools/registry.js";
import type { CompactionConfig } from "@/src/config/schema.js";
import type { Logger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import type { MessagesRepo, MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";

export interface AgentModelTurnResult {
  provider: string;
  model: string;
  modelApi: string;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  content: AgentAssistantContentBlock[];
  usage: MessageUsage;
  errorMessage?: string;
}

export interface AgentModelTurnInput {
  sessionId: string;
  conversationId: string;
  scenario: ModelScenario;
  model: ResolvedModel;
  compactSummary: string | null;
  messages: Message[];
  signal: AbortSignal;
  onTextDelta?: (delta: { delta: string; accumulatedText: string }) => void;
}

export interface AgentModelRunner {
  runTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult>;
}

export interface RunAgentLoopInput {
  sessionId: string;
  scenario: ModelScenario;
  maxTurns?: number;
}

export interface RunAgentLoopResult {
  runId: string;
  sessionId: string;
  scenario: ModelScenario;
  modelId: string;
  appendedMessageIds: string[];
  toolExecutions: number;
  compaction: CompactionDecision;
  events: AgentRuntimeEvent[];
}

export interface AgentLoopDependencies {
  sessions: AgentSessionService;
  messages: MessagesRepo;
  models: ProviderRegistry;
  tools: ToolRegistry;
  cancel: SessionRunAbortRegistry;
  modelRunner: AgentModelRunner;
  storage: StorageDb;
  logger: Logger;
  compaction: CompactionConfig;
  now?: () => Date;
  createId?: () => string;
  emitEvent?: (event: AgentRuntimeEvent) => void;
}

export class AgentLoop {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly compactor: AgentCompactionService | null;

  constructor(private readonly deps: AgentLoopDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? (() => randomUUID());
    this.compactor = isCompactionModelRunner(deps.modelRunner)
      ? new AgentCompactionService({
          sessions: deps.sessions,
          models: deps.models,
          runner: deps.modelRunner,
          config: deps.compaction,
          logger: deps.logger,
          now: this.now,
        })
      : null;
  }

  async run(input: RunAgentLoopInput): Promise<RunAgentLoopResult> {
    const handle = this.deps.cancel.begin(input.sessionId);
    const maxTurns = input.maxTurns ?? 8;
    let context = this.deps.sessions.getContext(input.sessionId);
    const model = this.deps.models.getRequiredScenarioModel(input.scenario);
    let messages = [...context.messages];
    const events: AgentRuntimeEvent[] = [];
    const appendedMessageIds: string[] = [];
    let toolExecutions = 0;
    let nextSeq = this.deps.messages.getNextSeq(input.sessionId);
    const runId = this.createId();
    let compactionRequested = false;
    let latestCompaction = decideCompaction({
      contextTokens: 0,
      contextWindow: model.contextWindow,
      config: this.deps.compaction,
    });

    try {
      this.recordEvent(events, {
        type: "run_started",
        scenario: input.scenario,
        modelId: model.id,
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        runId,
      });

      for (let turn = 0; turn < maxTurns; turn += 1) {
        throwIfAborted(handle.signal);
        let turnToolExecutions = 0;

        this.recordEvent(events, {
          type: "turn_started",
          turn: turn + 1,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        const assistantMessageId = this.createId();
        let sawStreamedText = false;
        let overflowRecovered = false;
        let response: AgentModelTurnResult;

        while (true) {
          this.recordEvent(events, {
            type: "assistant_message_started",
            turn: turn + 1,
            messageId: assistantMessageId,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });

          try {
            response = await this.deps.modelRunner.runTurn({
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              scenario: input.scenario,
              model,
              compactSummary: context.compactSummary,
              messages,
              signal: handle.signal,
              onTextDelta: (event) => {
                sawStreamedText = true;
                this.recordEvent(events, {
                  type: "assistant_message_delta",
                  turn: turn + 1,
                  messageId: assistantMessageId,
                  delta: event.delta,
                  accumulatedText: event.accumulatedText,
                  sessionId: input.sessionId,
                  conversationId: context.session.conversationId,
                  branchId: context.session.branchId,
                  runId,
                });
              },
            });
            break;
          } catch (error) {
            if (
              overflowRecovered ||
              !isAgentLlmError(error) ||
              error.kind !== "context_overflow" ||
              this.compactor == null
            ) {
              throw error;
            }

            latestCompaction = decideCompaction({
              contextTokens: 0,
              contextWindow: model.contextWindow,
              config: this.deps.compaction,
              overflow: true,
            });
            compactionRequested = true;
            this.recordEvent(events, {
              type: "compaction_requested",
              reason: "overflow",
              thresholdTokens: latestCompaction.thresholdTokens,
              effectiveWindow: latestCompaction.effectiveWindow,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
            });

            const compactionResult = await this.compactor.compactNow({
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
              reason: "overflow",
              signal: handle.signal,
              emitEvent: (event) => this.recordEvent(events, event),
            });

            if (!compactionResult.compacted) {
              throw error;
            }

            overflowRecovered = true;
            sawStreamedText = false;
            context = this.deps.sessions.getContext(input.sessionId);
            messages = [...context.messages];
          }
        }

        throwIfAborted(handle.signal);

        const assistantText = collectAssistantText(response.content);
        const toolCalls = collectAgentToolCalls(response.content);
        // Some runners will stream deltas incrementally, others may only return
        // the final assistant payload. We keep one event shape and only fall back
        // to a single full-text delta if nothing was streamed.
        if (!sawStreamedText && assistantText.length > 0) {
          this.recordEvent(events, {
            type: "assistant_message_delta",
            turn: turn + 1,
            messageId: assistantMessageId,
            delta: assistantText,
            accumulatedText: assistantText,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });
        }
        const assistantMessage = appendMessageAndHydrate({
          repo: this.deps.messages,
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          seq: nextSeq,
          role: "assistant",
          messageType: "text",
          visibility: "user_visible",
          provider: response.provider,
          model: response.model,
          modelApi: response.modelApi,
          stopReason: response.stopReason,
          errorMessage: response.errorMessage ?? null,
          payload: {
            content: response.content,
          } satisfies AgentAssistantPayload,
          usage: response.usage,
          createdAt: this.now(),
        });
        nextSeq += 1;
        messages.push(assistantMessage);
        appendedMessageIds.push(assistantMessageId);
        this.recordEvent(events, {
          type: "assistant_message_completed",
          turn: turn + 1,
          messageId: assistantMessageId,
          text: assistantText,
          toolCalls,
          usage: response.usage,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        if (toolCalls.length === 0) {
          this.recordEvent(events, {
            type: "turn_completed",
            turn: turn + 1,
            toolCallsRequested: 0,
            toolExecutions: 0,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });
          break;
        }

        for (const toolCall of toolCalls) {
          throwIfAborted(handle.signal);

          this.recordEvent(events, {
            type: "tool_call_started",
            turn: turn + 1,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.args,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });

          try {
            const result = await this.deps.tools.execute(
              toolCall.name,
              {
                sessionId: input.sessionId,
                conversationId: context.session.conversationId,
                storage: this.deps.storage,
                logger: this.deps.logger,
                abortSignal: handle.signal,
                toolCallId: toolCall.id,
              },
              toolCall.args,
            );

            throwIfAborted(handle.signal);

            const toolResultMessageId = this.createId();
            const toolResultMessage = appendMessageAndHydrate({
              repo: this.deps.messages,
              sessionId: input.sessionId,
              messageId: toolResultMessageId,
              seq: nextSeq,
              role: "tool",
              messageType: "tool_result",
              visibility: "hidden_system",
              payload: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: result.content,
                isError: false,
                ...(result.details !== undefined ? { details: result.details } : {}),
              } satisfies AgentToolResultPayload,
              createdAt: this.now(),
            });
            nextSeq += 1;
            messages.push(toolResultMessage);
            appendedMessageIds.push(toolResultMessageId);
            toolExecutions += 1;
            turnToolExecutions += 1;
            this.recordEvent(events, {
              type: "tool_call_completed",
              turn: turn + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              messageId: toolResultMessageId,
              result,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
            });
          } catch (error) {
            throwIfAborted(handle.signal);
            const failure = normalizeToolFailure(error);
            this.recordEvent(events, {
              type: "tool_call_failed",
              turn: turn + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              errorKind: failure.kind,
              errorMessage: failure.message,
              retryable: failure.retryable,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
            });

            if (!failure.shouldReturnToLlm) {
              throw failure;
            }

            const toolResultMessageId = this.createId();
            const toolResultMessage = appendMessageAndHydrate({
              repo: this.deps.messages,
              sessionId: input.sessionId,
              messageId: toolResultMessageId,
              seq: nextSeq,
              role: "tool",
              messageType: "tool_result",
              visibility: "hidden_system",
              payload: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: buildToolFailureContent(failure),
                isError: true,
                ...(failure.details !== undefined ? { details: failure.details } : {}),
              } satisfies AgentToolResultPayload,
              createdAt: this.now(),
            });
            nextSeq += 1;
            messages.push(toolResultMessage);
            appendedMessageIds.push(toolResultMessageId);
            toolExecutions += 1;
            turnToolExecutions += 1;
          }
        }

        this.recordEvent(events, {
          type: "turn_completed",
          turn: turn + 1,
          toolCallsRequested: toolCalls.length,
          toolExecutions: turnToolExecutions,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });
      }

      const compactionEstimate = estimateSessionContextTokens({
        compactSummary: context.compactSummary,
        compactSummaryTokenTotal: context.compactSummaryTokenTotal,
        compactSummaryUsageJson: context.compactSummaryUsageJson,
        messages,
      });
      const compaction = decideCompaction({
        contextTokens: compactionEstimate.tokens,
        contextWindow: model.contextWindow,
        config: this.deps.compaction,
      });
      latestCompaction = compaction.shouldCompact ? compaction : latestCompaction;

      if (compaction.shouldCompact && compaction.reason != null) {
        compactionRequested = true;
        this.recordEvent(events, {
          type: "compaction_requested",
          reason: compaction.reason,
          thresholdTokens: compaction.thresholdTokens,
          effectiveWindow: compaction.effectiveWindow,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        if (this.compactor != null) {
          queueMicrotask(() => {
            void this.compactor?.schedule({
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
              reason: compaction.reason as "threshold",
              emitEvent: (event) => this.recordEvent(events, event),
            });
          });
        }
      }

      this.recordEvent(events, {
        type: "run_completed",
        scenario: input.scenario,
        modelId: model.id,
        appendedMessageIds: [...appendedMessageIds],
        toolExecutions,
        compactionRequested,
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        runId,
      });

      return {
        runId,
        sessionId: input.sessionId,
        scenario: input.scenario,
        modelId: model.id,
        appendedMessageIds,
        toolExecutions,
        compaction: latestCompaction,
        events,
      };
    } catch (error) {
      const normalizedError = toRunFailure(error);
      this.recordEvent(events, {
        type: "run_failed",
        scenario: input.scenario,
        modelId: model.id,
        errorKind: normalizedError.kind,
        errorMessage: normalizedError.message,
        retryable: normalizedError.retryable,
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        runId,
      });
      throw error;
    } finally {
      handle.finish();
    }
  }

  private recordEvent(events: AgentRuntimeEvent[], event: AgentRuntimeEventInput): void {
    const hydrated = {
      ...event,
      eventId: this.createId(),
      createdAt: this.now().toISOString(),
    } satisfies AgentRuntimeEvent;

    events.push(hydrated);
    this.deps.emitEvent?.(hydrated);
  }
}

function appendMessageAndHydrate(input: {
  repo: MessagesRepo;
  sessionId: string;
  messageId: string;
  seq: number;
  role: string;
  messageType: string;
  visibility: string;
  provider?: string | null;
  model?: string | null;
  modelApi?: string | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  payload: unknown;
  usage?: MessageUsage | null;
  createdAt: Date;
}): Message {
  const payloadJson = JSON.stringify(input.payload);
  input.repo.append({
    id: input.messageId,
    sessionId: input.sessionId,
    seq: input.seq,
    role: input.role,
    messageType: input.messageType,
    visibility: input.visibility,
    provider: input.provider ?? null,
    model: input.model ?? null,
    modelApi: input.modelApi ?? null,
    stopReason: input.stopReason ?? null,
    errorMessage: input.errorMessage ?? null,
    payloadJson,
    usage: input.usage ?? null,
    createdAt: input.createdAt,
  });

  return {
    id: input.messageId,
    sessionId: input.sessionId,
    seq: input.seq,
    role: input.role,
    messageType: input.messageType,
    visibility: input.visibility,
    channelMessageId: null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    modelApi: input.modelApi ?? null,
    stopReason: input.stopReason ?? null,
    errorMessage: input.errorMessage ?? null,
    payloadJson,
    tokenInput: input.usage?.input ?? null,
    tokenOutput: input.usage?.output ?? null,
    tokenCacheRead: input.usage?.cacheRead ?? null,
    tokenCacheWrite: input.usage?.cacheWrite ?? null,
    tokenTotal: input.usage?.totalTokens ?? null,
    usageJson: input.usage == null ? null : JSON.stringify(input.usage),
    createdAt: input.createdAt.toISOString(),
  };
}

function collectAssistantText(content: AgentAssistantContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function collectAgentToolCalls(content: AgentAssistantContentBlock[]): AgentToolCall[] {
  return content.flatMap((block) =>
    block.type === "toolCall"
      ? [
          {
            id: block.id,
            name: block.name,
            args: block.arguments,
          } satisfies AgentToolCall,
        ]
      : [],
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(typeof reason === "string" ? reason : "Operation aborted");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

function isCompactionModelRunner(
  runner: AgentModelRunner,
): runner is AgentModelRunner & CompactionModelRunner {
  return "runCompaction" in runner && typeof runner.runCompaction === "function";
}

function toRunFailure(error: unknown): {
  kind:
    | import("@/src/agent/llm/errors.js").AgentLlmErrorKind
    | import("@/src/agent/tools/errors.js").ToolFailureKind
    | "unknown";
  message: string;
  retryable: boolean;
} {
  if (isAgentLlmError(error)) {
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (isToolFailure(error)) {
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    kind: "unknown",
    message: getErrorMessage(error),
    retryable: false,
  };
}
