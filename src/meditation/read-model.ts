import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or } from "drizzle-orm";

import type { StorageDb } from "@/src/storage/db/client.js";
import {
  agents,
  harnessEvents,
  messages,
  sessions,
  taskRuns,
} from "@/src/storage/schema/tables.js";

export interface MeditationStopFact {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  taskRunId: string | null;
  conversationId: string | null;
  branchId: string | null;
  createdAt: string;
  sourceKind: string;
  requestScope: string;
}

export interface MeditationTaskFailureFact {
  id: string;
  ownerAgentId: string;
  executionSessionId: string | null;
  description: string | null;
  resultSummary: string | null;
  errorText: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface MeditationFailedToolResultFact {
  id: string;
  sessionId: string;
  ownerAgentId: string | null;
  seq: number;
  createdAt: string;
  toolName: string;
  detailsCode: string | null;
  requestScopeKind: string | null;
  requestPrefix0: string | null;
  contentText: string;
}

export interface MeditationMessageWindowEntry {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  messageType: string;
  visibility: string;
  stopReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  payloadJson: string;
}

export interface MeditationBucketProfile {
  agentId: string;
  kind: string;
  displayName: string | null;
  description: string | null;
  workdir: string | null;
  compactSummary: string | null;
}

type ToolResultPayload = {
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
};

type ToolFailureDetails = {
  code?: unknown;
  request?: {
    scopes?: Array<{ kind?: unknown }>;
    prefix?: unknown;
  };
};

export class MeditationReadModel {
  constructor(private readonly db: StorageDb) {}

  listStopFacts(windowStart: string, windowEnd: string): MeditationStopFact[] {
    return this.db
      .select({
        runId: harnessEvents.runId,
        sessionId: harnessEvents.sessionId,
        agentId: harnessEvents.agentId,
        taskRunId: harnessEvents.taskRunId,
        conversationId: harnessEvents.conversationId,
        branchId: harnessEvents.branchId,
        createdAt: harnessEvents.createdAt,
        sourceKind: harnessEvents.sourceKind,
        requestScope: harnessEvents.requestScope,
      })
      .from(harnessEvents)
      .where(
        and(
          eq(harnessEvents.eventType, "user_stop"),
          gte(harnessEvents.createdAt, windowStart),
          lte(harnessEvents.createdAt, windowEnd),
        ),
      )
      .orderBy(asc(harnessEvents.createdAt), asc(harnessEvents.id))
      .all();
  }

  listTaskFailureFacts(windowStart: string, windowEnd: string): MeditationTaskFailureFact[] {
    return this.db
      .select({
        id: taskRuns.id,
        ownerAgentId: taskRuns.ownerAgentId,
        executionSessionId: taskRuns.executionSessionId,
        description: taskRuns.description,
        resultSummary: taskRuns.resultSummary,
        errorText: taskRuns.errorText,
        status: taskRuns.status,
        startedAt: taskRuns.startedAt,
        finishedAt: taskRuns.finishedAt,
      })
      .from(taskRuns)
      .where(
        and(
          inArray(taskRuns.status, ["failed", "blocked", "cancelled"]),
          lte(taskRuns.startedAt, windowEnd),
          or(isNotNull(taskRuns.finishedAt), gte(taskRuns.startedAt, windowStart)),
        ),
      )
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
      .all()
      .filter(
        (row) =>
          row.finishedAt == null || row.finishedAt >= windowStart || row.startedAt >= windowStart,
      );
  }

  listFailedToolResults(windowStart: string, windowEnd: string): MeditationFailedToolResultFact[] {
    const rows = this.db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        ownerAgentId: sessions.ownerAgentId,
        seq: messages.seq,
        createdAt: messages.createdAt,
        payloadJson: messages.payloadJson,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(
        and(
          eq(messages.messageType, "tool_result"),
          gte(messages.createdAt, windowStart),
          lte(messages.createdAt, windowEnd),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.seq), asc(messages.id))
      .all();

    return rows.flatMap((row) => {
      const payload = parseJson<ToolResultPayload>(row.payloadJson);
      if (payload == null || payload.isError !== true) {
        return [];
      }

      const details = isPlainObject(payload.details)
        ? (payload.details as ToolFailureDetails)
        : null;
      const prefix0 = Array.isArray(details?.request?.prefix)
        ? typeof details?.request?.prefix[0] === "string"
          ? (details?.request?.prefix[0] as string)
          : null
        : null;

      return [
        {
          id: row.id,
          sessionId: row.sessionId,
          ownerAgentId: row.ownerAgentId,
          seq: row.seq,
          createdAt: row.createdAt,
          toolName: typeof payload.toolName === "string" ? payload.toolName : "unknown",
          detailsCode: typeof details?.code === "string" ? details.code : null,
          requestScopeKind:
            typeof details?.request?.scopes?.[0]?.kind === "string"
              ? details.request.scopes[0]?.kind
              : null,
          requestPrefix0: prefix0,
          contentText: extractToolResultText(payload.content),
        },
      ];
    });
  }

  listSessionMessageWindow(
    sessionId: string,
    aroundSeq: number,
    before: number,
    after: number,
  ): MeditationMessageWindowEntry[] {
    return this.db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        seq: messages.seq,
        role: messages.role,
        messageType: messages.messageType,
        visibility: messages.visibility,
        stopReason: messages.stopReason,
        errorMessage: messages.errorMessage,
        createdAt: messages.createdAt,
        payloadJson: messages.payloadJson,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          gte(messages.seq, Math.max(1, aroundSeq - before)),
          lte(messages.seq, aroundSeq + after),
        ),
      )
      .orderBy(asc(messages.seq))
      .all();
  }

  listSessionMessageWindowByTime(
    sessionId: string,
    aroundCreatedAt: string,
    before: number,
    after: number,
  ): MeditationMessageWindowEntry[] {
    const beforeRows =
      before <= 0
        ? []
        : this.db
            .select({
              id: messages.id,
              sessionId: messages.sessionId,
              seq: messages.seq,
              role: messages.role,
              messageType: messages.messageType,
              visibility: messages.visibility,
              stopReason: messages.stopReason,
              errorMessage: messages.errorMessage,
              createdAt: messages.createdAt,
              payloadJson: messages.payloadJson,
            })
            .from(messages)
            .where(and(eq(messages.sessionId, sessionId), lte(messages.createdAt, aroundCreatedAt)))
            .orderBy(desc(messages.createdAt), desc(messages.seq), desc(messages.id))
            .limit(before)
            .all()
            .reverse();

    const afterRows =
      after <= 0
        ? []
        : this.db
            .select({
              id: messages.id,
              sessionId: messages.sessionId,
              seq: messages.seq,
              role: messages.role,
              messageType: messages.messageType,
              visibility: messages.visibility,
              stopReason: messages.stopReason,
              errorMessage: messages.errorMessage,
              createdAt: messages.createdAt,
              payloadJson: messages.payloadJson,
            })
            .from(messages)
            .where(and(eq(messages.sessionId, sessionId), gte(messages.createdAt, aroundCreatedAt)))
            .orderBy(asc(messages.createdAt), asc(messages.seq), asc(messages.id))
            .limit(after)
            .all();

    return dedupeMessageWindowEntries([...beforeRows, ...afterRows]);
  }

  resolveBucketProfile(
    agentId: string,
    preferredSessionIds: string[] = [],
  ): MeditationBucketProfile | null {
    const agent = this.db
      .select({
        agentId: agents.id,
        kind: agents.kind,
        displayName: agents.displayName,
        description: agents.description,
        workdir: agents.workdir,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    if (agent == null) {
      return null;
    }

    const preferredSummary =
      preferredSessionIds.length === 0
        ? null
        : this.db
            .select({
              compactSummary: sessions.compactSummary,
            })
            .from(sessions)
            .where(
              and(inArray(sessions.id, preferredSessionIds), isNotNull(sessions.compactSummary)),
            )
            .orderBy(desc(sessions.updatedAt), desc(sessions.id))
            .get();

    const fallbackSummary =
      preferredSummary != null
        ? null
        : this.db
            .select({
              compactSummary: sessions.compactSummary,
            })
            .from(sessions)
            .where(and(eq(sessions.ownerAgentId, agentId), isNotNull(sessions.compactSummary)))
            .orderBy(desc(sessions.updatedAt), desc(sessions.id))
            .get();

    return {
      agentId: agent.agentId,
      kind: agent.kind,
      displayName: agent.displayName,
      description: agent.description,
      workdir: agent.workdir,
      compactSummary: preferredSummary?.compactSummary ?? fallbackSummary?.compactSummary ?? null,
    };
  }
}

function parseJson<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function extractToolResultText(content: ToolResultPayload["content"]): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((entry) => isPlainObject(entry) && typeof entry.text === "string")
    .map((entry) => String(entry.text))
    .join("\n")
    .trim();
}

function dedupeMessageWindowEntries(
  entries: MeditationMessageWindowEntry[],
): MeditationMessageWindowEntry[] {
  const seen = new Set<string>();
  const deduped: MeditationMessageWindowEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    deduped.push(entry);
  }

  return deduped.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq || a.id.localeCompare(b.id),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
