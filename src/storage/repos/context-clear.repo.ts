import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { AgentUserPayload, AgentUserRuntimeImagePayload } from "@/src/agent/llm/messages.js";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import {
  contextClearPendingInputs,
  contextClearRuns,
  sessions,
} from "@/src/storage/schema/tables.js";
import type {
  ContextClearPendingInput,
  ContextClearRun,
  NewContextClearPendingInput,
  NewContextClearRun,
} from "@/src/storage/schema/types.js";

const ACTIVE_CLEAR_STATUSES = ["pending", "running"];

export interface EnqueueContextClearInput {
  clearRunId: string;
  sessionId: string;
  scenario: ModelScenario;
  content: string;
  userPayload?: AgentUserPayload;
  runtimeImages?: AgentUserRuntimeImagePayload[];
  messageType?: string;
  visibility?: string;
  channelMessageId?: string | null;
  channelParentMessageId?: string | null;
  channelThreadId?: string | null;
  maxTurns?: number;
  createdAt?: Date;
}

export interface DrainedContextClearInput {
  messageId: string;
  sessionId: string;
  scenario: ModelScenario;
  runtimeImages: AgentUserRuntimeImagePayload[];
  maxTurns: number | null;
}

export interface SettledContextClearRun {
  clearRun: ContextClearRun;
  drainedInputs: DrainedContextClearInput[];
  contextEpoch: number;
}

export class ContextClearRepo {
  constructor(private readonly db: StorageDb) {}

  createPending(input: {
    id: string;
    sessionId: string;
    sourceSeq: number;
    requestKey?: string | null;
    now?: Date;
  }): void {
    const now = toCanonicalUtcIsoTimestamp(input.now ?? new Date());
    const row: NewContextClearRun = {
      id: input.id,
      sessionId: input.sessionId,
      requestKey: input.requestKey ?? null,
      handoffSessionId: null,
      sourceSeq: input.sourceSeq,
      status: "pending",
      kickoffMessage: null,
      errorText: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      updatedAt: now,
    };
    this.db.insert(contextClearRuns).values(row).run();
  }

  getById(id: string): ContextClearRun | null {
    return this.db.select().from(contextClearRuns).where(eq(contextClearRuns.id, id)).get() ?? null;
  }

  findActiveBySession(sessionId: string): ContextClearRun | null {
    return (
      this.db
        .select()
        .from(contextClearRuns)
        .where(
          and(
            eq(contextClearRuns.sessionId, sessionId),
            inArray(contextClearRuns.status, ACTIVE_CLEAR_STATUSES),
          ),
        )
        .get() ?? null
    );
  }

  findByRequestKey(sessionId: string, requestKey: string): ContextClearRun | null {
    return (
      this.db
        .select()
        .from(contextClearRuns)
        .where(
          and(
            eq(contextClearRuns.sessionId, sessionId),
            eq(contextClearRuns.requestKey, requestKey),
          ),
        )
        .get() ?? null
    );
  }

  listActive(): ContextClearRun[] {
    return this.db
      .select()
      .from(contextClearRuns)
      .where(inArray(contextClearRuns.status, ACTIVE_CLEAR_STATUSES))
      .orderBy(asc(contextClearRuns.requestedAt))
      .all();
  }

  markRunning(input: {
    id: string;
    sourceSeq: number;
    handoffSessionId: string;
    now?: Date;
  }): void {
    const now = toCanonicalUtcIsoTimestamp(input.now ?? new Date());
    this.db
      .update(contextClearRuns)
      .set({
        sourceSeq: input.sourceSeq,
        handoffSessionId: input.handoffSessionId,
        status: "running",
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(contextClearRuns.id, input.id))
      .run();
  }

  enqueue(input: EnqueueContextClearInput): string {
    const active = this.getById(input.clearRunId);
    if (
      active == null ||
      active.sessionId !== input.sessionId ||
      !ACTIVE_CLEAR_STATUSES.includes(active.status)
    ) {
      throw new Error(`Context clear run ${input.clearRunId} is not accepting input.`);
    }
    const nextPosition =
      (this.db
        .select({ value: max(contextClearPendingInputs.position) })
        .from(contextClearPendingInputs)
        .where(eq(contextClearPendingInputs.clearRunId, input.clearRunId))
        .get()?.value ?? 0) + 1;
    const id = randomUUID();
    const row: NewContextClearPendingInput = {
      id,
      clearRunId: input.clearRunId,
      sessionId: input.sessionId,
      position: nextPosition,
      scenario: input.scenario,
      content: input.content,
      userPayloadJson: input.userPayload == null ? null : JSON.stringify(input.userPayload),
      runtimeImagesJson: input.runtimeImages == null ? null : JSON.stringify(input.runtimeImages),
      messageType: input.messageType ?? null,
      visibility: input.visibility ?? null,
      channelMessageId: input.channelMessageId ?? null,
      channelParentMessageId: input.channelParentMessageId ?? null,
      channelThreadId: input.channelThreadId ?? null,
      maxTurns: input.maxTurns ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(input.createdAt ?? new Date()),
    };
    this.db.insert(contextClearPendingInputs).values(row).run();
    return id;
  }

  complete(input: { id: string; kickoffMessage: string; now?: Date }): SettledContextClearRun {
    return this.db.transaction((tx) => {
      const clearRepo = new ContextClearRepo(tx);
      const clearRun = clearRepo.requireActive(input.id);
      const sourceSession = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, clearRun.sessionId))
        .get();
      if (sourceSession == null) {
        throw new Error(`Context clear source session not found: ${clearRun.sessionId}`);
      }
      const messagesRepo = new MessagesRepo(tx);
      let nextSeq = messagesRepo.getNextSeq(clearRun.sessionId);
      messagesRepo.append({
        id: randomUUID(),
        sessionId: clearRun.sessionId,
        seq: nextSeq,
        role: "user",
        payloadJson: JSON.stringify({
          content: buildFreshContextKickoff({
            sessionId: clearRun.sessionId,
            sourceSeq: clearRun.sourceSeq,
            kickoffMessage: input.kickoffMessage,
          }),
        }),
        messageType: "context_clear_kickoff",
        visibility: "hidden_system",
        createdAt: input.now ?? new Date(),
      });
      nextSeq += 1;
      const drainedInputs = clearRepo.appendPendingInputs({
        clearRun,
        messagesRepo,
        startingSeq: nextSeq,
      });
      const now = toCanonicalUtcIsoTimestamp(input.now ?? new Date());
      tx.update(sessions)
        .set({
          compactCursor: clearRun.sourceSeq,
          compactSummary: null,
          compactSummaryTokenTotal: null,
          compactSummaryUsageJson: null,
          contextEpoch: sql`${sessions.contextEpoch} + 1`,
          compactionsSinceClear: 0,
          lastClearReminderCount: 0,
          updatedAt: now,
        })
        .where(eq(sessions.id, clearRun.sessionId))
        .run();
      tx.update(contextClearRuns)
        .set({
          status: "completed",
          kickoffMessage: input.kickoffMessage,
          errorText: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(contextClearRuns.id, input.id))
        .run();
      clearRepo.endHandoffSession(clearRun.handoffSessionId, now);
      tx.delete(contextClearPendingInputs)
        .where(eq(contextClearPendingInputs.clearRunId, input.id))
        .run();
      return {
        clearRun: clearRepo.requireById(input.id),
        drainedInputs,
        contextEpoch: sourceSession.contextEpoch + 1,
      };
    });
  }

  fail(input: { id: string; errorText: string; now?: Date }): SettledContextClearRun {
    return this.db.transaction((tx) => {
      const clearRepo = new ContextClearRepo(tx);
      const clearRun = clearRepo.requireActive(input.id);
      const sourceSession = tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, clearRun.sessionId))
        .get();
      if (sourceSession == null) {
        throw new Error(`Context clear source session not found: ${clearRun.sessionId}`);
      }
      const drainedInputs = clearRepo.appendPendingInputs({
        clearRun,
        messagesRepo: new MessagesRepo(tx),
        startingSeq: new MessagesRepo(tx).getNextSeq(clearRun.sessionId),
      });
      const now = toCanonicalUtcIsoTimestamp(input.now ?? new Date());
      tx.update(contextClearRuns)
        .set({ status: "failed", errorText: input.errorText, failedAt: now, updatedAt: now })
        .where(eq(contextClearRuns.id, input.id))
        .run();
      clearRepo.endHandoffSession(clearRun.handoffSessionId, now);
      tx.delete(contextClearPendingInputs)
        .where(eq(contextClearPendingInputs.clearRunId, input.id))
        .run();
      return {
        clearRun: clearRepo.requireById(input.id),
        drainedInputs,
        contextEpoch: sourceSession.contextEpoch,
      };
    });
  }

  private appendPendingInputs(input: {
    clearRun: ContextClearRun;
    messagesRepo: MessagesRepo;
    startingSeq: number;
  }): DrainedContextClearInput[] {
    const pending = this.db
      .select()
      .from(contextClearPendingInputs)
      .where(eq(contextClearPendingInputs.clearRunId, input.clearRun.id))
      .orderBy(asc(contextClearPendingInputs.position))
      .all();
    return pending.map((row, index) => {
      const messageId = randomUUID();
      input.messagesRepo.append({
        id: messageId,
        sessionId: input.clearRun.sessionId,
        seq: input.startingSeq + index,
        role: "user",
        payloadJson: row.userPayloadJson ?? JSON.stringify({ content: row.content }),
        messageType: row.messageType ?? "text",
        visibility: row.visibility ?? "user_visible",
        channelMessageId: row.channelMessageId,
        channelParentMessageId: row.channelParentMessageId,
        channelThreadId: row.channelThreadId,
        createdAt: new Date(row.createdAt),
      });
      return deserializeDrainedInput(row, messageId);
    });
  }

  private requireActive(id: string): ContextClearRun {
    const row = this.requireById(id);
    if (!ACTIVE_CLEAR_STATUSES.includes(row.status)) {
      throw new Error(`Context clear run ${id} is already ${row.status}.`);
    }
    return row;
  }

  private requireById(id: string): ContextClearRun {
    const row = this.getById(id);
    if (row == null) {
      throw new Error(`Context clear run not found: ${id}`);
    }
    return row;
  }

  private endHandoffSession(handoffSessionId: string | null, now: string): void {
    if (handoffSessionId == null) {
      return;
    }
    this.db
      .update(sessions)
      .set({ status: "ended", updatedAt: now, endedAt: now })
      .where(eq(sessions.id, handoffSessionId))
      .run();
  }
}

function deserializeDrainedInput(
  row: ContextClearPendingInput,
  messageId: string,
): DrainedContextClearInput {
  return {
    messageId,
    sessionId: row.sessionId,
    scenario: row.scenario === "task" ? "task" : "chat",
    runtimeImages: parseRuntimeImages(row.runtimeImagesJson),
    maxTurns: row.maxTurns,
  };
}

function parseRuntimeImages(value: string | null): AgentUserRuntimeImagePayload[] {
  if (value == null) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AgentUserRuntimeImagePayload[]) : [];
  } catch {
    return [];
  }
}

function buildFreshContextKickoff(input: {
  sessionId: string;
  sourceSeq: number;
  kickoffMessage: string;
}): string {
  return [
    "<context_clear_kickoff>",
    "The host has replaced the old LLM message list with a fresh context. This is an internal continuity message, not a user message.",
    `Session ID: ${input.sessionId}`,
    `Previous-context boundary: seq ${input.sourceSeq}`,
    "Earlier raw messages are not loaded into this context, but they remain available in the read-only system database. Do not mistake unloaded history for unavailable history.",
    "When the current request depends on earlier information that is missing, uncertain, conflicting, or needs exact verification, use query_system_db with this session ID before answering or acting.",
    "",
    input.kickoffMessage.trim(),
    "</context_clear_kickoff>",
  ].join("\n");
}
