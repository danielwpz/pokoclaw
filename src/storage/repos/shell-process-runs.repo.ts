import { and, desc, eq, inArray } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { shellProcessRuns } from "@/src/storage/schema/tables.js";
import type { NewShellProcessRun, ShellProcessRun } from "@/src/storage/schema/types.js";

export const ACTIVE_SHELL_PROCESS_STATUSES = ["starting", "running"] as const;

export interface CreateShellProcessRunInput {
  id: string;
  ownerAgentId: string;
  sourceSessionId: string;
  conversationId: string;
  branchId: string;
  toolCallId?: string | null;
  sourceRunId?: string | null;
  commandPreview: string;
  commandHash: string;
  cwd: string;
  sandboxMode: "sandboxed" | "full_access";
  timeoutMs: number | null;
  notifyOnExit: "next_turn" | "wake";
  startedAt?: Date;
}

export interface SettleShellProcessRunInput {
  id: string;
  status: "completed" | "failed" | "timed_out" | "killed" | "lost";
  finishedAt: Date;
  durationMs: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  exitReason?: string | null;
  errorText?: string | null;
  stdoutChars: number;
  stderrChars: number;
  outputTail: string;
  outputTruncated: boolean;
  notificationStatus: "none" | "pending" | "suppressed";
}

export class ShellProcessRunsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateShellProcessRunInput): void {
    const row: NewShellProcessRun = {
      id: input.id,
      ownerAgentId: input.ownerAgentId,
      sourceSessionId: input.sourceSessionId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      toolCallId: input.toolCallId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      commandPreview: input.commandPreview,
      commandHash: input.commandHash,
      cwd: input.cwd,
      sandboxMode: input.sandboxMode,
      status: "starting",
      pid: null,
      timeoutMs: input.timeoutMs,
      notifyOnExit: input.notifyOnExit,
      startedAt: toCanonicalUtcIsoTimestamp(input.startedAt ?? new Date()),
      handedOffAt: null,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      exitSignal: null,
      exitReason: null,
      errorText: null,
      stdoutChars: 0,
      stderrChars: 0,
      outputTail: "",
      outputTruncated: false,
      notificationStatus: "none",
    };
    this.db.insert(shellProcessRuns).values(row).run();
  }

  getById(id: string): ShellProcessRun | null {
    return this.db.select().from(shellProcessRuns).where(eq(shellProcessRuns.id, id)).get() ?? null;
  }

  getOwned(id: string, ownerAgentId: string): ShellProcessRun | null {
    return (
      this.db
        .select()
        .from(shellProcessRuns)
        .where(and(eq(shellProcessRuns.id, id), eq(shellProcessRuns.ownerAgentId, ownerAgentId)))
        .get() ?? null
    );
  }

  listByOwner(ownerAgentId: string, limit = 20): ShellProcessRun[] {
    return this.db
      .select()
      .from(shellProcessRuns)
      .where(eq(shellProcessRuns.ownerAgentId, ownerAgentId))
      .orderBy(desc(shellProcessRuns.startedAt), desc(shellProcessRuns.id))
      .limit(limit)
      .all();
  }

  listActive(): ShellProcessRun[] {
    return this.db
      .select()
      .from(shellProcessRuns)
      .where(inArray(shellProcessRuns.status, [...ACTIVE_SHELL_PROCESS_STATUSES]))
      .orderBy(desc(shellProcessRuns.startedAt), desc(shellProcessRuns.id))
      .all();
  }

  listPendingNotifications(): ShellProcessRun[] {
    return this.db
      .select()
      .from(shellProcessRuns)
      .where(eq(shellProcessRuns.notificationStatus, "pending"))
      .orderBy(shellProcessRuns.finishedAt, shellProcessRuns.id)
      .all();
  }

  markRunning(input: { id: string; pid: number | null }): void {
    this.db
      .update(shellProcessRuns)
      .set({ status: "running", pid: input.pid })
      .where(eq(shellProcessRuns.id, input.id))
      .run();
  }

  markHandedOff(id: string, handedOffAt = new Date()): void {
    this.db
      .update(shellProcessRuns)
      .set({ handedOffAt: toCanonicalUtcIsoTimestamp(handedOffAt) })
      .where(eq(shellProcessRuns.id, id))
      .run();
  }

  settle(input: SettleShellProcessRunInput): void {
    this.db
      .update(shellProcessRuns)
      .set({
        status: input.status,
        finishedAt: toCanonicalUtcIsoTimestamp(input.finishedAt),
        durationMs: input.durationMs,
        exitCode: input.exitCode ?? null,
        exitSignal: input.exitSignal ?? null,
        exitReason: input.exitReason ?? null,
        errorText: input.errorText ?? null,
        stdoutChars: input.stdoutChars,
        stderrChars: input.stderrChars,
        outputTail: input.outputTail,
        outputTruncated: input.outputTruncated,
        notificationStatus: input.notificationStatus,
      })
      .where(eq(shellProcessRuns.id, input.id))
      .run();
  }

  markNotificationDelivered(id: string): void {
    this.db
      .update(shellProcessRuns)
      .set({ notificationStatus: "delivered" })
      .where(eq(shellProcessRuns.id, id))
      .run();
  }

  markNotificationSuppressed(id: string): void {
    this.db
      .update(shellProcessRuns)
      .set({ notificationStatus: "suppressed" })
      .where(eq(shellProcessRuns.id, id))
      .run();
  }
}
