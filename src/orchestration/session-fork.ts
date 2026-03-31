import { randomUUID } from "node:crypto";

import type { StorageDb } from "@/src/storage/db/client.js";
import { extractStoredMessageUsage, MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { type CreateSessionInput, SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Message, Session } from "@/src/storage/schema/types.js";

export interface MaterializeForkedSessionSnapshotInput {
  db: StorageDb;
  targetSession: CreateSessionInput;
  sourceSessionId: string;
  forkSourceSeq?: number | null | undefined;
}

export function materializeForkedSessionSnapshot(
  input: MaterializeForkedSessionSnapshotInput,
): Session {
  return input.db.transaction((tx) =>
    materializeForkedSessionSnapshotInStorage({ ...input, db: tx }),
  );
}

export function materializeForkedSessionSnapshotInStorage(
  input: MaterializeForkedSessionSnapshotInput,
): Session {
  const sessionsRepo = new SessionsRepo(input.db);
  const messagesRepo = new MessagesRepo(input.db);
  const sourceSession = sessionsRepo.getById(input.sourceSessionId);
  if (sourceSession == null) {
    throw new Error(`Cannot fork from missing source session ${input.sourceSessionId}`);
  }

  const forkSourceSeq = resolveForkSourceSeq({
    messagesRepo,
    sourceSessionId: input.sourceSessionId,
    requestedForkSourceSeq: input.forkSourceSeq,
  });

  if (forkSourceSeq < sourceSession.compactCursor) {
    throw new Error(
      `Cannot fork session ${input.sourceSessionId} before compact cursor ${sourceSession.compactCursor}`,
    );
  }

  sessionsRepo.create({
    ...input.targetSession,
    forkedFromSessionId: input.sourceSessionId,
    forkSourceSeq,
    compactCursor: 0,
    compactSummary: sourceSession.compactSummary,
    compactSummaryTokenTotal: sourceSession.compactSummaryTokenTotal,
    compactSummaryUsageJson: sourceSession.compactSummaryUsageJson,
  });

  const copiedMessages = messagesRepo.listBySession(input.sourceSessionId, {
    afterSeq: sourceSession.compactCursor,
    uptoSeq: forkSourceSeq,
  });

  for (const [index, message] of copiedMessages.entries()) {
    messagesRepo.append(copyMessageIntoTargetSession(message, input.targetSession.id, index + 1));
  }

  const created = sessionsRepo.getById(input.targetSession.id);
  if (created == null) {
    throw new Error(`Failed to create forked session ${input.targetSession.id}`);
  }

  return created;
}

function resolveForkSourceSeq(input: {
  messagesRepo: MessagesRepo;
  sourceSessionId: string;
  requestedForkSourceSeq?: number | null | undefined;
}): number {
  const latestSeq = Math.max(0, input.messagesRepo.getNextSeq(input.sourceSessionId) - 1);
  if (input.requestedForkSourceSeq == null) {
    return latestSeq;
  }

  if (!Number.isInteger(input.requestedForkSourceSeq) || input.requestedForkSourceSeq < 0) {
    throw new Error("forkSourceSeq must be a non-negative integer");
  }

  if (input.requestedForkSourceSeq > latestSeq) {
    throw new Error(
      `Cannot fork source session ${input.sourceSessionId} beyond latest seq ${latestSeq}`,
    );
  }

  return input.requestedForkSourceSeq;
}

function copyMessageIntoTargetSession(source: Message, targetSessionId: string, targetSeq: number) {
  return {
    id: randomUUID(),
    sessionId: targetSessionId,
    seq: targetSeq,
    role: source.role,
    payloadJson: source.payloadJson,
    createdAt: new Date(source.createdAt),
    messageType: source.messageType,
    visibility: source.visibility,
    channelMessageId: source.channelMessageId,
    channelParentMessageId: source.channelParentMessageId,
    channelThreadId: source.channelThreadId,
    provider: source.provider,
    model: source.model,
    modelApi: source.modelApi,
    stopReason: source.stopReason,
    errorMessage: source.errorMessage,
    tokenInput: source.tokenInput,
    tokenOutput: source.tokenOutput,
    tokenCacheRead: source.tokenCacheRead,
    tokenCacheWrite: source.tokenCacheWrite,
    tokenTotal: source.tokenTotal,
    usage: extractStoredMessageUsage(source),
  };
}
