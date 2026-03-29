/**
 * In-memory hot-wait registry for pending approvals.
 *
 * When a tool call is blocked on approval, AgentLoop waits here for a bounded
 * window. Approval decisions can resume immediately; user messages can be
 * buffered as steer inputs and replayed after unblock.
 */
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("approval-waits");

export interface PendingSteerInput {
  content: string;
  createdAt?: Date;
}

// This registry owns the in-memory hot path for permission approval.
// A paused tool call waits here for a short time window; approval responses can
// resolve it immediately, while normal inbound messages are collected as steer
// and replayed after the blocked tool call completes.
export interface ApprovalResponseInput {
  approvalId: number;
  decision: "approve" | "deny";
  actor: string;
  rawInput?: string | null;
  grantedBy?: "user" | "main_agent";
  reasonText?: string | null;
  expiresAt?: Date | null;
  decidedAt?: Date;
}

export interface ApprovalWaitOutcome {
  decision: "approve" | "deny";
  actor: string;
  rawInput: string | null;
  grantedBy: "user" | "main_agent" | null;
  reasonText: string | null;
  expiresAt?: Date | null;
  decidedAt: Date;
  queuedSteer: PendingSteerInput[];
}

type ResolvedApprovalWait = Omit<ApprovalWaitOutcome, "queuedSteer">;

interface PendingApprovalWaitEntry {
  sessionId: string;
  approvalId: number;
  steerQueue: PendingSteerInput[];
  resolve: (outcome: ResolvedApprovalWait) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class SessionApprovalWaitRegistry {
  private readonly waitsBySessionId = new Map<string, PendingApprovalWaitEntry>();
  private readonly waitsByApprovalId = new Map<number, PendingApprovalWaitEntry>();

  // Begin the hot-path wait for a pending approval. The approval record still
  // exists in SQLite for durability, but normal approve/deny flows should hit
  // this in-memory wait rather than rebuilding the run from storage.
  beginWait(input: {
    sessionId: string;
    approvalId: number;
    timeoutMs: number;
  }): Promise<ApprovalWaitOutcome> {
    if (this.waitsBySessionId.has(input.sessionId)) {
      throw new Error(`Session ${input.sessionId} already has a pending approval wait`);
    }
    if (this.waitsByApprovalId.has(input.approvalId)) {
      throw new Error(`Approval ${input.approvalId} is already pending`);
    }

    return new Promise<ApprovalWaitOutcome>((resolve) => {
      const entry: PendingApprovalWaitEntry = {
        sessionId: input.sessionId,
        approvalId: input.approvalId,
        steerQueue: [],
        resolve: (outcome) => {
          const queuedSteer = [...entry.steerQueue];
          clearTimeout(entry.timeout);
          this.waitsBySessionId.delete(entry.sessionId);
          this.waitsByApprovalId.delete(entry.approvalId);
          resolve({
            ...outcome,
            queuedSteer,
          });
        },
        timeout: setTimeout(() => {
          logger.info("approval wait timed out", {
            sessionId: input.sessionId,
            approvalId: input.approvalId,
          });
          entry.resolve({
            decision: "deny",
            actor: "system:timeout",
            rawInput: null,
            grantedBy: null,
            reasonText: "Approval request timed out.",
            decidedAt: new Date(),
          });
        }, input.timeoutMs),
      };

      this.waitsBySessionId.set(input.sessionId, entry);
      this.waitsByApprovalId.set(input.approvalId, entry);
      logger.info("waiting for approval reply", {
        sessionId: input.sessionId,
        approvalId: input.approvalId,
        timeoutMs: input.timeoutMs,
      });
    });
  }

  resolveApproval(input: ApprovalResponseInput): boolean {
    const entry = this.waitsByApprovalId.get(input.approvalId);
    if (entry == null) {
      logger.debug("approval reply did not match a pending wait", {
        approvalId: input.approvalId,
        decision: input.decision,
      });
      return false;
    }

    logger.info("received approval reply for pending wait", {
      sessionId: entry.sessionId,
      approvalId: input.approvalId,
      decision: input.decision,
      actor: input.actor,
    });
    entry.resolve({
      decision: input.decision,
      actor: input.actor,
      rawInput: input.rawInput ?? null,
      grantedBy: input.grantedBy ?? null,
      reasonText: input.reasonText ?? null,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      decidedAt: input.decidedAt ?? new Date(),
    });
    return true;
  }

  enqueueSteer(input: { sessionId: string; content: string; createdAt?: Date }): boolean {
    const entry = this.waitsBySessionId.get(input.sessionId);
    if (entry == null) {
      return false;
    }

    logger.debug("queued steer while waiting for approval", {
      sessionId: input.sessionId,
      approvalId: entry.approvalId,
    });
    entry.steerQueue.push({
      content: input.content,
      ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
    });
    return true;
  }

  cancelSession(input: {
    sessionId: string;
    actor?: string;
    rawInput?: string | null;
    reasonText?: string | null;
    decidedAt?: Date;
  }): boolean {
    const entry = this.waitsBySessionId.get(input.sessionId);
    if (entry == null) {
      return false;
    }

    logger.info("cancelled approval wait", {
      sessionId: input.sessionId,
      approvalId: entry.approvalId,
      actor: input.actor ?? "system:cancel",
    });
    entry.resolve({
      decision: "deny",
      actor: input.actor ?? "system:cancel",
      rawInput: input.rawInput ?? null,
      grantedBy: null,
      reasonText: input.reasonText ?? "Approval wait was cancelled.",
      decidedAt: input.decidedAt ?? new Date(),
    });
    return true;
  }

  hasPendingSession(sessionId: string): boolean {
    return this.waitsBySessionId.has(sessionId);
  }
}
