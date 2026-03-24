import { randomUUID } from "node:crypto";
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
  AgentUserPayload,
} from "@/src/agent/llm/messages.js";
import type { ModelScenario, ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AgentSessionService } from "@/src/agent/session.js";
import type { CompactionConfig, SecurityConfig } from "@/src/config/schema.js";
import {
  type ApprovalResponseInput,
  type ApprovalWaitOutcome,
  SessionApprovalWaitRegistry,
} from "@/src/runtime/approval-waits.js";
import type { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionSteerQueueRegistry, type SteerInput } from "@/src/runtime/steer-queue.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { describePermissionScope, type PermissionRequest } from "@/src/security/scope.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import type { MessagesRepo, MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";
import {
  buildToolFailureContent,
  isToolApprovalRequired,
  isToolFailure,
  normalizeToolFailure,
} from "@/src/tools/errors.js";
import type { ToolRegistry } from "@/src/tools/registry.js";
import { type ToolResult, textToolResult } from "@/src/tools/types.js";

const logger = createSubsystemLogger("agent-loop");

// AgentLoop is the execution core for a single session run.
// It owns model turns, tool execution, compaction hooks, and the runtime-side
// approval pause/resume control flow. It does not own transport ingress or
// cross-session coordination; that belongs to src/runtime/*.
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
  securityConfig: SecurityConfig;
  compaction: CompactionConfig;
  approvalTimeoutMs?: number;
  approvalGrantTtlMs?: number;
  emitEvent?: (event: AgentRuntimeEvent) => void;
}

interface ApprovalResumePayload {
  toolCallId: string;
  toolName: string;
  toolArgs: unknown;
  turn: number;
  runId: string;
}

interface ExecutedToolCall {
  result: ToolResult;
  isError: boolean;
  queuedSteer: SteerInput[];
}

export class AgentLoop {
  private readonly compactor: AgentCompactionService | null;
  private readonly security: SecurityService;
  private readonly approvalWaits = new SessionApprovalWaitRegistry();
  private readonly steerQueue = new SessionSteerQueueRegistry();
  private readonly approvalTimeoutMs: number;
  private readonly approvalGrantTtlMs: number;

  constructor(private readonly deps: AgentLoopDependencies) {
    this.security = new SecurityService(
      deps.storage,
      buildSystemPolicy({ security: deps.securityConfig }),
    );
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? 3 * 60 * 1000;
    this.approvalGrantTtlMs = deps.approvalGrantTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.compactor = isCompactionModelRunner(deps.modelRunner)
      ? new AgentCompactionService({
          sessions: deps.sessions,
          models: deps.models,
          runner: deps.modelRunner,
          config: deps.compaction,
        })
      : null;
  }

  submitApprovalResponse(input: ApprovalResponseInput): boolean {
    return this.approvalWaits.resolveApproval(input);
  }

  // Runtime-level steer injection. Session lanes call this while a run is
  // active so the new message can be inserted at the next safe boundary.
  enqueueSteerInput(input: { sessionId: string; content: string; createdAt?: Date }): boolean {
    if (!this.deps.cancel.isActive(input.sessionId)) {
      return false;
    }

    this.steerQueue.enqueue(input);
    return true;
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
    const runId = randomUUID();
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
        logger.debug("starting model turn", {
          sessionId: input.sessionId,
          turn: turn + 1,
          runId,
          tail: summarizeTranscriptTail(messages),
        });

        this.recordEvent(events, {
          type: "turn_started",
          turn: turn + 1,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        const assistantMessageId = randomUUID();
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
            logger.info("context overflow; compacting before retry", {
              sessionId: input.sessionId,
              modelId: model.id,
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

            logger.info("compaction finished; retrying turn", {
              sessionId: input.sessionId,
              cursor: compactionResult.compactCursor,
              summaryTokens: compactionResult.summaryTokenTotal,
              runId,
            });

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
          createdAt: new Date(),
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
          const queuedSteer = this.steerQueue.drain(input.sessionId);
          if (queuedSteer.length > 0) {
            logger.info("steering inbound message after turn", {
              sessionId: input.sessionId,
              turn: turn + 1,
              runId,
              count: queuedSteer.length,
              latest: truncateLogText(queuedSteer.at(-1)?.content ?? "", 48),
            });
            nextSeq = this.appendQueuedSteerMessages({
              queuedSteer,
              sessionId: input.sessionId,
              nextSeq,
              messages,
              appendedMessageIds,
            });
          }

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

          if (queuedSteer.length > 0) {
            continue;
          }
          break;
        }

        const queuedSteerAfterTurn: SteerInput[] = [];
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
            const executedTool = await this.executeToolCall({
              input,
              context,
              toolCall,
              turn: turn + 1,
              runId,
              events,
              signal: handle.signal,
            });

            throwIfAborted(handle.signal);

            const toolResultMessageId = randomUUID();
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
                content: executedTool.result.content,
                isError: executedTool.isError,
                ...(executedTool.result.details !== undefined
                  ? { details: executedTool.result.details }
                  : {}),
              } satisfies AgentToolResultPayload,
              createdAt: new Date(),
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
              result: executedTool.result,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
            });

            if (executedTool.queuedSteer.length > 0) {
              queuedSteerAfterTurn.push(...executedTool.queuedSteer);
            }
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

            const toolResultMessageId = randomUUID();
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
              createdAt: new Date(),
            });
            nextSeq += 1;
            messages.push(toolResultMessage);
            appendedMessageIds.push(toolResultMessageId);
            toolExecutions += 1;
            turnToolExecutions += 1;
          }
        }

        const queuedSteer = [...queuedSteerAfterTurn, ...this.steerQueue.drain(input.sessionId)];
        if (queuedSteer.length > 0) {
          logger.info("steering inbound message after tool batch", {
            sessionId: input.sessionId,
            turn: turn + 1,
            runId,
            count: queuedSteer.length,
            latest: truncateLogText(queuedSteer.at(-1)?.content ?? "", 48),
            tail: summarizeTranscriptTail(messages),
          });
          nextSeq = this.appendQueuedSteerMessages({
            queuedSteer,
            sessionId: input.sessionId,
            nextSeq,
            messages,
            appendedMessageIds,
          });
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

        if (queuedSteer.length > 0) {
        }
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
      logger.debug("checked context size for compaction", {
        sessionId: input.sessionId,
        modelId: model.id,
        contextTokens: compactionEstimate.tokens,
        threshold: compaction.thresholdTokens,
        runId,
      });
      latestCompaction = compaction.shouldCompact ? compaction : latestCompaction;

      if (compaction.shouldCompact && compaction.reason != null) {
        compactionRequested = true;
        logger.info("queueing background compaction", {
          sessionId: input.sessionId,
          modelId: model.id,
          contextTokens: compactionEstimate.tokens,
          threshold: compaction.thresholdTokens,
          runId,
        });
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
      this.steerQueue.clear(input.sessionId);
      handle.finish();
    }
  }

  private async executeToolCall(input: {
    input: RunAgentLoopInput;
    context: ReturnType<AgentSessionService["getContext"]>;
    toolCall: AgentToolCall;
    turn: number;
    runId: string;
    events: AgentRuntimeEvent[];
    signal: AbortSignal;
  }): Promise<ExecutedToolCall> {
    const queuedSteer: SteerInput[] = [];

    while (true) {
      try {
        const result = await this.deps.tools.execute(
          input.toolCall.name,
          {
            sessionId: input.input.sessionId,
            conversationId: input.context.session.conversationId,
            ownerAgentId: input.context.session.ownerAgentId,
            cwd: POKECLAW_WORKSPACE_DIR,
            securityConfig: this.deps.securityConfig,
            storage: this.deps.storage,
            abortSignal: input.signal,
            toolCallId: input.toolCall.id,
          },
          input.toolCall.args,
        );

        return {
          result,
          isError: false,
          queuedSteer,
        };
      } catch (error) {
        if (!isToolApprovalRequired(error)) {
          throw error;
        }

        const approval = await this.requestApproval({
          runInput: input.input,
          context: input.context,
          toolCall: input.toolCall,
          turn: input.turn,
          runId: input.runId,
          request: error.request,
          reasonText: error.reasonText,
          events: input.events,
          signal: input.signal,
        });

        if (approval.decision === "approve") {
          queuedSteer.push(...approval.queuedSteer);
          const grantedBy = approval.grantedBy ?? "user";
          const grantExpiresAt =
            approval.expiresAt === undefined
              ? new Date(approval.decidedAt.getTime() + this.approvalGrantTtlMs)
              : approval.expiresAt;

          this.security.approveRequestAndGrantScopes({
            approvalId: approval.approvalId,
            grantedBy,
            reasonText: approval.reasonText,
            decidedAt: approval.decidedAt,
            expiresAt: grantExpiresAt,
          });
          continue;
        }

        this.security.resolveApproval({
          approvalId: approval.approvalId,
          status: "denied",
          reasonText: approval.reasonText,
          decidedAt: approval.decidedAt,
        });

        return {
          result: textToolResult(
            approval.reasonText == null || approval.reasonText.length === 0
              ? "Permission request denied."
              : approval.reasonText,
            {
              approvalId: approval.approvalId,
              request: approval.request,
            },
          ),
          isError: true,
          queuedSteer: [...queuedSteer, ...approval.queuedSteer],
        };
      }
    }
  }

  private async requestApproval(input: {
    runInput: RunAgentLoopInput;
    context: ReturnType<AgentSessionService["getContext"]>;
    toolCall: AgentToolCall;
    turn: number;
    runId: string;
    request: PermissionRequest;
    reasonText: string;
    events: AgentRuntimeEvent[];
    signal: AbortSignal;
  }): Promise<ApprovalWaitOutcome & { approvalId: number; request: PermissionRequest }> {
    // Approval is modeled as pause/resume, not as a finished tool failure.
    // We persist the request for durability, then wait on the in-memory hot
    // path so normal approve/deny responses can resume the same tool call.
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.approvalTimeoutMs);
    const resumePayloadJson = JSON.stringify({
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      toolArgs: input.toolCall.args,
      turn: input.turn,
      runId: input.runId,
    } satisfies ApprovalResumePayload);
    const approvalId = this.security.createApprovalRequest({
      ownerAgentId: input.context.session.ownerAgentId ?? "",
      requestedBySessionId: input.runInput.sessionId,
      request: input.request,
      approvalTarget: "user",
      reasonText: input.reasonText,
      createdAt,
      expiresAt,
      resumePayloadJson,
    });
    logger.info("approval requested for tool call", {
      sessionId: input.runInput.sessionId,
      approvalId,
      toolName: input.toolCall.name,
      scopeCount: input.request.scopes.length,
      scope:
        input.request.scopes[0] == null
          ? undefined
          : describePermissionScope(input.request.scopes[0]),
      runId: input.runId,
    });

    const waitPromise = this.approvalWaits.beginWait({
      sessionId: input.runInput.sessionId,
      approvalId,
      timeoutMs: this.approvalTimeoutMs,
    });

    this.deps.sessions.updateStatus({
      id: input.runInput.sessionId,
      status: "paused",
      updatedAt: createdAt,
    });

    this.recordEvent(input.events, {
      type: "approval_requested",
      approvalId: String(approvalId),
      title: buildApprovalTitle(input.request),
      reasonText: input.reasonText,
      options: ["Approve for 7 days", "Approve permanently", "Deny"],
      expiresAt: expiresAt.toISOString(),
      sessionId: input.runInput.sessionId,
      conversationId: input.context.session.conversationId,
      branchId: input.context.session.branchId,
      runId: input.runId,
    });

    const onAbort = () => {
      this.approvalWaits.cancelSession({
        sessionId: input.runInput.sessionId,
        actor: "system:cancel",
        reasonText: "Run cancelled while waiting for approval.",
        decidedAt: new Date(),
      });
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const outcome = await waitPromise;
      if (input.signal.aborted && outcome.actor === "system:cancel") {
        this.security.resolveApproval({
          approvalId,
          status: "cancelled",
          reasonText: outcome.reasonText,
          decidedAt: outcome.decidedAt,
        });
        throwIfAborted(input.signal);
      }

      this.recordEvent(input.events, {
        type: "approval_resolved",
        approvalId: String(approvalId),
        decision: outcome.decision,
        actor: outcome.actor,
        rawInput: outcome.rawInput,
        sessionId: input.runInput.sessionId,
        conversationId: input.context.session.conversationId,
        branchId: input.context.session.branchId,
        runId: input.runId,
      });
      logger.info("approval resolved for tool call", {
        sessionId: input.runInput.sessionId,
        approvalId,
        toolName: input.toolCall.name,
        decision: outcome.decision,
        actor: outcome.actor,
        runId: input.runId,
      });

      return {
        ...outcome,
        approvalId,
        request: input.request,
      };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      this.deps.sessions.updateStatus({
        id: input.runInput.sessionId,
        status: "active",
        updatedAt: new Date(),
      });
    }
  }

  private appendQueuedSteerMessages(input: {
    queuedSteer: SteerInput[];
    sessionId: string;
    nextSeq: number;
    messages: Message[];
    appendedMessageIds: string[];
  }): number {
    let nextSeq = input.nextSeq;

    for (const queued of input.queuedSteer) {
      const messageId = randomUUID();
      const message = appendMessageAndHydrate({
        repo: this.deps.messages,
        sessionId: input.sessionId,
        messageId,
        seq: nextSeq,
        role: "user",
        messageType: "text",
        visibility: "user_visible",
        payload: {
          content: queued.content,
        } satisfies AgentUserPayload,
        createdAt: queued.createdAt ?? new Date(),
      });
      nextSeq += 1;
      input.messages.push(message);
      input.appendedMessageIds.push(messageId);
    }

    return nextSeq;
  }

  private recordEvent(events: AgentRuntimeEvent[], event: AgentRuntimeEventInput): void {
    const hydrated = {
      ...event,
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
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

function buildApprovalTitle(request: PermissionRequest): string {
  const firstScope = request.scopes[0];
  if (request.scopes.length === 1 && firstScope != null) {
    return `Approval required: ${describePermissionScope(firstScope)}`;
  }

  return `Approval required for ${request.scopes.length} permissions`;
}

function summarizeTranscriptTail(messages: Message[], maxMessages: number = 6) {
  const summary = messages.slice(-maxMessages).map((message) => {
    if (message.role === "user") {
      const payload = safeParsePayload<{ content?: unknown }>(message.payloadJson);
      const content =
        typeof payload?.content === "string" ? truncateLogText(payload.content, 24) : "non-text";
      return `u:${content}`;
    }

    if (message.role === "tool") {
      const payload = safeParsePayload<{
        toolName?: unknown;
        toolCallId?: unknown;
        isError?: unknown;
      }>(message.payloadJson);
      const toolName = typeof payload?.toolName === "string" ? payload.toolName : "unknown";
      return payload?.isError === true ? `t:${toolName}:err` : `t:${toolName}`;
    }

    const payload = safeParsePayload<{ content?: Array<{ type?: string; text?: string }> }>(
      message.payloadJson,
    );
    const text = Array.isArray(payload?.content)
      ? payload.content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join(" ")
      : "";
    const stopReason = message.stopReason ?? "?";
    const summaryText = text.length > 0 ? `:${truncateLogText(text, 16)}` : "";
    return `a:${stopReason}${summaryText}`;
  });

  return truncateLogText(summary.join(">"), 72);
}

function safeParsePayload<T>(payloadJson: string): T | null {
  try {
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}

function truncateLogText(text: string, maxLength: number = 80) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
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
    | import("@/src/tools/errors.js").ToolFailureKind
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
