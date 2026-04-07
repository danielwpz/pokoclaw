import { randomUUID } from "node:crypto";

/**
 * Runtime control-plane service for active runs.
 *
 * This service has two responsibilities that intentionally live together:
 * - active-run registration and cancellation
 * - lightweight in-memory observability for currently running work
 *
 * Keeping these concerns in one runtime-owned service avoids leaking direct
 * access to execution internals while still giving tools and status surfaces a
 * single place to query live run state.
 */
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import {
  createInitialRunLiveObservabilityState,
  estimateOutputTokensFromChars,
  type RunLiveLatestRequestState,
  type RunLiveObservabilitySnapshot,
  type RunLiveObservabilityState,
  type RunLiveRequestStatus,
  toRunLiveObservabilitySnapshot,
} from "@/src/runtime/run-observability.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { HarnessEventsRepo } from "@/src/storage/repos/harness-events.repo.js";
import type { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";

const logger = createSubsystemLogger("runtime-control");

export type HarnessStopSourceKind = "command" | "button";
export type HarnessStopRequestScope = "run" | "session" | "conversation";

export interface RuntimeControlPersistence {
  harnessEvents: HarnessEventsRepo;
  sessions: SessionsRepo;
  taskRuns: TaskRunsRepo;
}

export interface ActiveRunRecord {
  runId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  scenario: ModelScenario;
}

export interface StopRunInput {
  runId: string;
  actor: string;
  sourceKind: HarnessStopSourceKind;
  requestScope: HarnessStopRequestScope;
  reasonText?: string;
}

export interface StopConversationInput {
  conversationId: string;
  actor: string;
  sourceKind: HarnessStopSourceKind;
  requestScope: HarnessStopRequestScope;
  reasonText?: string;
}

export interface StopSessionInput {
  sessionId: string;
  actor: string;
  sourceKind: HarnessStopSourceKind;
  requestScope: HarnessStopRequestScope;
  reasonText?: string;
}

export interface StopRunResult {
  accepted: boolean;
  runId: string;
  sessionId: string | null;
  conversationId: string | null;
}

export interface StopConversationResult {
  acceptedCount: number;
  conversationId: string;
  runIds: string[];
  sessionIds: string[];
}

export interface StopSessionResult {
  accepted: boolean;
  sessionId: string;
  runIds: string[];
  conversationId: string | null;
}

export class RuntimeControlService {
  private readonly runsByRunId = new Map<string, ActiveRunRecord>();
  private readonly observabilityByRunId = new Map<string, RunLiveObservabilityState>();

  constructor(
    private readonly cancel: SessionRunAbortRegistry,
    private readonly persistence?: RuntimeControlPersistence,
  ) {}

  beginRun(input: ActiveRunRecord): void {
    this.runsByRunId.set(input.runId, input);
    this.observabilityByRunId.set(
      input.runId,
      createInitialRunLiveObservabilityState({
        runId: input.runId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        branchId: input.branchId,
        scenario: input.scenario,
      }),
    );
    logger.debug("registered active run", {
      runId: input.runId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      scenario: input.scenario,
    });
  }

  finishRun(runId: string): void {
    const existing = this.runsByRunId.get(runId);
    if (existing == null) {
      return;
    }

    this.runsByRunId.delete(runId);
    logger.debug("released active run", {
      runId,
      sessionId: existing.sessionId,
      conversationId: existing.conversationId,
    });
  }

  stopRun(input: StopRunInput): StopRunResult {
    const run = this.runsByRunId.get(input.runId) ?? null;
    if (run == null) {
      logger.info("stop run ignored because no active run matched", {
        runId: input.runId,
        actor: input.actor,
      });
      return {
        accepted: false,
        runId: input.runId,
        sessionId: null,
        conversationId: null,
      };
    }

    const accepted = this.cancel.cancel(
      run.sessionId,
      input.reasonText ?? `stop requested by ${input.actor}`,
    );
    if (accepted) {
      this.recordHarnessStopEvent(run, input);
    }
    logger.info("processed stop run request", {
      runId: input.runId,
      sessionId: run.sessionId,
      conversationId: run.conversationId,
      actor: input.actor,
      accepted,
    });

    return {
      accepted,
      runId: input.runId,
      sessionId: run.sessionId,
      conversationId: run.conversationId,
    };
  }

  stopConversation(input: StopConversationInput): StopConversationResult {
    const matches = Array.from(this.runsByRunId.values()).filter(
      (run) => run.conversationId === input.conversationId,
    );
    const stopped: ActiveRunRecord[] = [];

    for (const run of matches) {
      const accepted = this.cancel.cancel(
        run.sessionId,
        input.reasonText ?? `stop requested by ${input.actor}`,
      );
      if (accepted) {
        stopped.push(run);
        this.recordHarnessStopEvent(run, input);
      }
    }

    logger.info("processed stop conversation request", {
      conversationId: input.conversationId,
      actor: input.actor,
      acceptedCount: stopped.length,
      runIds: stopped.map((run) => run.runId),
    });

    return {
      acceptedCount: stopped.length,
      conversationId: input.conversationId,
      runIds: stopped.map((run) => run.runId),
      sessionIds: stopped.map((run) => run.sessionId),
    };
  }

  stopSession(input: StopSessionInput): StopSessionResult {
    const matches = Array.from(this.runsByRunId.values()).filter(
      (run) => run.sessionId === input.sessionId,
    );
    const stopped: ActiveRunRecord[] = [];

    for (const run of matches) {
      const accepted = this.cancel.cancel(
        run.sessionId,
        input.reasonText ?? `stop requested by ${input.actor}`,
      );
      if (accepted) {
        stopped.push(run);
        this.recordHarnessStopEvent(run, input);
      }
    }

    logger.info("processed stop session request", {
      sessionId: input.sessionId,
      actor: input.actor,
      acceptedCount: stopped.length,
      runIds: stopped.map((run) => run.runId),
    });

    return {
      accepted: stopped.length > 0,
      sessionId: input.sessionId,
      runIds: stopped.map((run) => run.runId),
      conversationId: stopped[0]?.conversationId ?? null,
    };
  }

  listActiveRunsByConversation(conversationId: string): ActiveRunRecord[] {
    return Array.from(this.runsByRunId.values()).filter(
      (run) => run.conversationId === conversationId,
    );
  }

  markLlmRequestStarted(input: { runId: string; assistantMessageId: string; at?: Date }): void {
    this.updateObservability(input.runId, (state) => {
      const startedAt = input.at ?? new Date();
      const nextSequence = state.responseSummary.requestCount + 1;
      return {
        ...state,
        phase: "running",
        runStartedAt: state.runStartedAt ?? startedAt,
        latestRequest: {
          sequence: nextSequence,
          status: "waiting_first_token",
          startedAt,
          finishedAt: null,
          firstTokenAt: null,
          lastTokenAt: null,
          outputChars: 0,
          estimatedOutputTokens: 0,
          finalOutputTokens: null,
          activeAssistantMessageId: input.assistantMessageId,
        },
        responseSummary: {
          ...state.responseSummary,
          requestCount: nextSequence,
        },
        activeToolCallId: null,
        activeToolName: null,
        waitingApprovalId: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
      };
    });
  }

  recordStreamDelta(input: {
    runId: string;
    kind: "text" | "reasoning";
    deltaText?: string;
    at?: Date;
  }): void {
    this.updateObservability(input.runId, (state) => {
      const latestRequest = state.latestRequest;
      if (latestRequest == null) {
        logger.debug("ignored stream delta because no latest request is active", {
          runId: input.runId,
          kind: input.kind,
        });
        return state;
      }
      if (state.phase !== "running") {
        logger.debug("ignored stream delta because run phase does not accept streaming updates", {
          runId: input.runId,
          phase: state.phase,
          kind: input.kind,
        });
        return state;
      }

      const now = input.at ?? new Date();
      const outputChars =
        input.kind === "text"
          ? latestRequest.outputChars + Math.max(0, input.deltaText?.length ?? 0)
          : latestRequest.outputChars;
      const firstTokenAt = latestRequest.firstTokenAt ?? now;
      const becameResponded = latestRequest.firstTokenAt == null;
      return {
        ...state,
        phase: "running",
        latestRequest: {
          ...latestRequest,
          status: "streaming",
          firstTokenAt,
          lastTokenAt: now,
          outputChars,
          estimatedOutputTokens: estimateOutputTokensFromChars(outputChars),
        },
        responseSummary: {
          requestCount: state.responseSummary.requestCount,
          respondedRequestCount:
            state.responseSummary.respondedRequestCount + (becameResponded ? 1 : 0),
          firstResponseAt: state.responseSummary.firstResponseAt ?? now,
          lastResponseAt: now,
          lastRespondedRequestSequence: latestRequest.sequence,
          lastRespondedRequestTtftMs: Math.max(
            0,
            firstTokenAt.getTime() - latestRequest.startedAt.getTime(),
          ),
        },
      };
    });
  }

  markToolStarted(input: { runId: string; toolCallId: string; toolName: string; at?: Date }): void {
    this.updateObservability(input.runId, (state) => ({
      ...state,
      phase: "tool_running",
      latestRequest: finalizeLatestRequest(state.latestRequest, "finished", input.at ?? new Date()),
      activeToolCallId: input.toolCallId,
      activeToolName: input.toolName,
      waitingApprovalId: null,
    }));
  }

  markToolFinished(input: { runId: string; toolCallId: string }): void {
    this.updateObservability(input.runId, (state) => {
      if (state.activeToolCallId !== input.toolCallId) {
        return state;
      }

      return {
        ...state,
        phase: "running",
        activeToolCallId: null,
        activeToolName: null,
      };
    });
  }

  markWaitingApproval(input: { runId: string; approvalId: string }): void {
    this.updateObservability(input.runId, (state) => ({
      ...state,
      phase: "waiting_approval",
      latestRequest: finalizeLatestRequest(state.latestRequest, "finished", new Date()),
      waitingApprovalId: input.approvalId,
    }));
  }

  clearWaitingApproval(runId: string): void {
    this.updateObservability(runId, (state) => ({
      ...state,
      phase: state.phase === "waiting_approval" ? "running" : state.phase,
      waitingApprovalId: null,
    }));
  }

  setFinalOutputTokens(input: { runId: string; outputTokens: number | null | undefined }): void {
    const outputTokens = input.outputTokens;
    if (outputTokens == null || !Number.isFinite(outputTokens) || outputTokens < 0) {
      return;
    }

    this.updateObservability(input.runId, (state) => ({
      ...state,
      latestRequest:
        state.latestRequest == null
          ? null
          : {
              ...state.latestRequest,
              finalOutputTokens: outputTokens,
            },
    }));
  }

  markCompleted(input: { runId: string; at?: Date }): void {
    this.updateObservability(input.runId, (state) => {
      const at = input.at ?? new Date();
      return {
        ...state,
        phase: "completed",
        latestRequest: finalizeLatestRequest(state.latestRequest, "finished", at),
        completedAt: at,
        activeToolCallId: null,
        activeToolName: null,
        waitingApprovalId: null,
      };
    });
  }

  markFailed(input: { runId: string; at?: Date }): void {
    this.updateObservability(input.runId, (state) => {
      const at = input.at ?? new Date();
      return {
        ...state,
        phase: "failed",
        latestRequest: finalizeLatestRequest(state.latestRequest, "failed", at),
        failedAt: at,
        activeToolCallId: null,
        activeToolName: null,
        waitingApprovalId: null,
      };
    });
  }

  markCancelled(input: { runId: string; at?: Date }): void {
    this.updateObservability(input.runId, (state) => {
      const at = input.at ?? new Date();
      return {
        ...state,
        phase: "cancelled",
        latestRequest: finalizeLatestRequest(state.latestRequest, "cancelled", at),
        cancelledAt: at,
        activeToolCallId: null,
        activeToolName: null,
        waitingApprovalId: null,
      };
    });
  }

  getRunObservability(runId: string, now: Date = new Date()): RunLiveObservabilitySnapshot | null {
    const state = this.observabilityByRunId.get(runId) ?? null;
    return state == null ? null : toRunLiveObservabilitySnapshot(state, now);
  }

  listActiveRunObservability(now: Date = new Date()): RunLiveObservabilitySnapshot[] {
    return Array.from(this.runsByRunId.keys())
      .map((runId) => this.getRunObservability(runId, now))
      .filter((snapshot): snapshot is RunLiveObservabilitySnapshot => snapshot != null);
  }

  listActiveRunObservabilityByConversation(
    conversationId: string,
    now: Date = new Date(),
  ): RunLiveObservabilitySnapshot[] {
    return this.listActiveRunsByConversation(conversationId)
      .map((run) => this.getRunObservability(run.runId, now))
      .filter((snapshot): snapshot is RunLiveObservabilitySnapshot => snapshot != null);
  }

  private updateObservability(
    runId: string,
    updater: (state: RunLiveObservabilityState) => RunLiveObservabilityState,
  ): void {
    const existing = this.observabilityByRunId.get(runId);
    if (existing == null) {
      logger.debug("skipped observability update for unknown run", { runId });
      return;
    }

    this.observabilityByRunId.set(runId, updater(existing));
  }

  private recordHarnessStopEvent(
    run: ActiveRunRecord,
    input: StopRunInput | StopSessionInput | StopConversationInput,
  ): void {
    if (this.persistence == null) {
      return;
    }

    const taskRun = this.persistence.taskRuns.getByExecutionSessionId(run.sessionId);
    const session = this.persistence.sessions.getById(run.sessionId);
    this.persistence.harnessEvents.create({
      id: randomUUID(),
      eventType: "user_stop",
      runId: run.runId,
      sessionId: run.sessionId,
      conversationId: run.conversationId,
      branchId: run.branchId,
      agentId: session?.ownerAgentId ?? taskRun?.ownerAgentId ?? null,
      taskRunId: taskRun?.id ?? null,
      cronJobId: taskRun?.cronJobId ?? null,
      actor: input.actor,
      sourceKind: input.sourceKind,
      requestScope: input.requestScope,
      reasonText: input.reasonText ?? null,
    });
  }
}

function finalizeLatestRequest(
  latestRequest: RunLiveLatestRequestState | null,
  status: Extract<RunLiveRequestStatus, "finished" | "failed" | "cancelled">,
  at: Date,
): RunLiveLatestRequestState | null {
  if (latestRequest == null) {
    return null;
  }

  if (
    latestRequest.status === "finished" ||
    latestRequest.status === "failed" ||
    latestRequest.status === "cancelled"
  ) {
    return latestRequest.finishedAt == null
      ? {
          ...latestRequest,
          finishedAt: at,
        }
      : latestRequest;
  }

  return {
    ...latestRequest,
    status,
    finishedAt: latestRequest.finishedAt ?? at,
  };
}
