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
    now?: () => Date;
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
          entry.resolve({
            decision: "deny",
            actor: "system:timeout",
            rawInput: null,
            grantedBy: null,
            reasonText: "Approval request timed out.",
            decidedAt: input.now?.() ?? new Date(),
          });
        }, input.timeoutMs),
      };

      this.waitsBySessionId.set(input.sessionId, entry);
      this.waitsByApprovalId.set(input.approvalId, entry);
    });
  }

  resolveApproval(input: ApprovalResponseInput): boolean {
    const entry = this.waitsByApprovalId.get(input.approvalId);
    if (entry == null) {
      return false;
    }

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
