import { randomUUID } from "node:crypto";
import type { AgentLoop } from "@/src/agent/loop.js";
import {
  buildContextHandoffRequest,
  extractContextHandoffSignal,
} from "@/src/context-clear/handoff.js";
import { materializeForkedSessionSnapshotInStorage } from "@/src/orchestration/session-fork.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import {
  ContextClearRepo,
  type DrainedContextClearInput,
  type EnqueueContextClearInput,
} from "@/src/storage/repos/context-clear.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { ContextClearRun } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("context-clear");
const CONTEXT_HANDOFF_MAX_TURNS = 12;

export interface ContextClearExecutionResult {
  status: "completed" | "failed";
  clearRunId: string;
  sessionId: string;
  contextEpoch: number;
  drainedInputs: DrainedContextClearInput[];
  errorMessage?: string;
}

export class ContextClearService {
  private readonly clears: ContextClearRepo;
  private readonly sessions: SessionsRepo;
  private readonly messages: MessagesRepo;

  constructor(
    private readonly deps: {
      storage: StorageDb;
      loop: AgentLoop;
    },
  ) {
    this.clears = new ContextClearRepo(deps.storage);
    this.sessions = new SessionsRepo(deps.storage);
    this.messages = new MessagesRepo(deps.storage);
  }

  request(sessionId: string, requestKey?: string | null): ContextClearRun {
    const existing = this.clears.findActiveBySession(sessionId);
    if (existing != null) {
      return existing;
    }
    const existingRequest =
      requestKey == null ? null : this.clears.findByRequestKey(sessionId, requestKey);
    if (existingRequest != null) {
      return existingRequest;
    }
    const session = this.sessions.getById(sessionId);
    if (session == null) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.purpose !== "chat") {
      throw new Error("Context clear is only available for Main Agent and SubAgent chat sessions.");
    }
    const owner =
      session.ownerAgentId == null
        ? null
        : new AgentsRepo(this.deps.storage).getById(session.ownerAgentId);
    if (owner == null || (owner.kind !== "main" && owner.kind !== "sub")) {
      throw new Error("Context clear requires a Main Agent or SubAgent session owner.");
    }
    const clearRunId = randomUUID();
    this.clears.createPending({
      id: clearRunId,
      sessionId,
      sourceSeq: Math.max(0, this.messages.getNextSeq(sessionId) - 1),
      ...(requestKey == null ? {} : { requestKey }),
    });
    const created = this.clears.getById(clearRunId);
    if (created == null) {
      throw new Error(`Failed to create context clear run ${clearRunId}`);
    }
    logger.info("context clear requested", { clearRunId, sessionId });
    return created;
  }

  enqueue(input: EnqueueContextClearInput): string {
    return this.clears.enqueue(input);
  }

  async execute(clearRunId: string): Promise<ContextClearExecutionResult> {
    const clearRun = this.clears.getById(clearRunId);
    if (clearRun == null) {
      throw new Error(`Context clear run not found: ${clearRunId}`);
    }
    if (clearRun.status === "completed") {
      return {
        status: "completed",
        clearRunId,
        sessionId: clearRun.sessionId,
        contextEpoch: this.sessions.getById(clearRun.sessionId)?.contextEpoch ?? 0,
        drainedInputs: [],
      };
    }
    if (clearRun.status === "failed") {
      return {
        status: "failed",
        clearRunId,
        sessionId: clearRun.sessionId,
        contextEpoch: this.sessions.getById(clearRun.sessionId)?.contextEpoch ?? 0,
        drainedInputs: [],
        errorMessage: clearRun.errorText ?? "Context handoff previously failed.",
      };
    }

    let handoffSessionId: string | null = clearRun.handoffSessionId;
    try {
      const sourceSession = this.sessions.getById(clearRun.sessionId);
      if (sourceSession == null) {
        throw new Error(`Context clear source session not found: ${clearRun.sessionId}`);
      }
      const sourceSeq = Math.max(0, this.messages.getNextSeq(clearRun.sessionId) - 1);
      handoffSessionId = handoffSessionId ?? randomUUID();
      const targetHandoffSessionId = handoffSessionId;
      if (clearRun.status === "pending") {
        this.deps.storage.transaction((tx) => {
          materializeForkedSessionSnapshotInStorage({
            db: tx,
            sourceSessionId: sourceSession.id,
            forkSourceSeq: sourceSeq,
            targetSession: {
              id: targetHandoffSessionId,
              conversationId: sourceSession.conversationId,
              branchId: sourceSession.branchId,
              ownerAgentId: sourceSession.ownerAgentId,
              purpose: "context_handoff",
              contextMode: sourceSession.contextMode,
              status: "active",
            },
          });
          new ContextClearRepo(tx).markRunning({
            id: clearRunId,
            sourceSeq,
            handoffSessionId: targetHandoffSessionId,
          });
        });
      }
      const running = this.clears.getById(clearRunId);
      if (running == null || running.handoffSessionId == null) {
        throw new Error(`Context clear run ${clearRunId} has no handoff session.`);
      }
      const requestMessageId = randomUUID();
      this.messages.append({
        id: requestMessageId,
        sessionId: running.handoffSessionId,
        seq: this.messages.getNextSeq(running.handoffSessionId),
        role: "user",
        payloadJson: JSON.stringify({
          content: buildContextHandoffRequest({
            sourceSessionId: running.sessionId,
            sourceSeq: running.sourceSeq,
          }),
        }),
        messageType: "context_handoff_request",
        visibility: "hidden_system",
      });

      logger.info("context handoff started", {
        clearRunId,
        sessionId: running.sessionId,
        handoffSessionId: running.handoffSessionId,
        sourceSeq: running.sourceSeq,
      });
      const run = await this.deps.loop.run({
        sessionId: running.handoffSessionId,
        scenario: "chat",
        maxTurns: CONTEXT_HANDOFF_MAX_TURNS,
        afterToolResultHook: {
          afterToolResult: ({ toolCall, result }) => {
            const handoff = extractContextHandoffSignal({ toolName: toolCall.name, result });
            if (handoff == null) {
              return { kind: "continue" };
            }
            return {
              kind: "stop_run",
              reason: "context_handoff_submitted",
              payload: { contextHandoff: handoff },
            };
          },
        },
      });
      const kickoffMessage = extractKickoffFromStopSignal(run.stopSignal?.payload);
      if (run.stopSignal?.reason !== "context_handoff_submitted" || kickoffMessage == null) {
        throw new Error("The handoff agent ended without calling submit_context_handoff.");
      }
      const settled = this.clears.complete({ id: clearRunId, kickoffMessage });
      logger.info("context clear completed", {
        clearRunId,
        sessionId: settled.clearRun.sessionId,
        sourceSeq: settled.clearRun.sourceSeq,
        contextEpoch: settled.contextEpoch,
        queuedInputCount: settled.drainedInputs.length,
      });
      return {
        status: "completed",
        clearRunId,
        sessionId: settled.clearRun.sessionId,
        contextEpoch: settled.contextEpoch,
        drainedInputs: settled.drainedInputs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const active = this.clears.findActiveBySession(clearRun.sessionId);
      if (active == null) {
        throw error;
      }
      const settled = this.clears.fail({ id: active.id, errorText: errorMessage });
      logger.error("context clear failed and original context was preserved", {
        clearRunId,
        sessionId: settled.clearRun.sessionId,
        handoffSessionId,
        error: errorMessage,
        queuedInputCount: settled.drainedInputs.length,
      });
      return {
        status: "failed",
        clearRunId,
        sessionId: settled.clearRun.sessionId,
        contextEpoch: settled.contextEpoch,
        drainedInputs: settled.drainedInputs,
        errorMessage,
      };
    }
  }

  recoverAfterRestart(): ContextClearExecutionResult[] {
    for (const run of this.clears.listActive()) {
      const errorMessage =
        "Context clear was interrupted by process restart; original context restored.";
      const settled = this.clears.fail({ id: run.id, errorText: errorMessage });
      logger.warn("recovered interrupted context clear", {
        clearRunId: run.id,
        sessionId: run.sessionId,
        queuedInputCount: settled.drainedInputs.length,
      });
    }

    const recoverable: ContextClearExecutionResult[] = [];
    for (const run of this.clears.listUnprocessedSettled()) {
      if (this.clears.hasPersistedResponseAfterQueuedInputs(run.id)) {
        this.clears.markQueuedInputsProcessed(run.id);
        logger.info("context clear queued input was already handled before restart", {
          clearRunId: run.id,
          sessionId: run.sessionId,
        });
        continue;
      }
      const drainedInputs = this.clears.listDrainedInputs(run.id);
      if (drainedInputs.length === 0) {
        this.clears.markQueuedInputsProcessed(run.id);
        continue;
      }
      recoverable.push({
        status: run.status === "completed" ? "completed" : "failed",
        clearRunId: run.id,
        sessionId: run.sessionId,
        contextEpoch: this.sessions.getById(run.sessionId)?.contextEpoch ?? 0,
        drainedInputs,
        ...(run.status === "failed"
          ? { errorMessage: run.errorText ?? "Context handoff previously failed." }
          : {}),
      });
    }
    return recoverable;
  }

  markQueuedInputsProcessed(clearRunId: string): void {
    this.clears.markQueuedInputsProcessed(clearRunId);
  }
}

function extractKickoffFromStopSignal(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.contextHandoff)) {
    return null;
  }
  const kickoffMessage = payload.contextHandoff.kickoffMessage;
  return typeof kickoffMessage === "string" && kickoffMessage.trim().length > 0
    ? kickoffMessage.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
