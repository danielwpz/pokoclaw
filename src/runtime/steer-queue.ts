/**
 * Session-local steer queue.
 *
 * Stores deferred user steering messages while a run is busy and lets runtime
 * replay them in order once the current execution stage allows it.
 */
import type { AgentUserPayload, AgentUserRuntimeImagePayload } from "@/src/agent/llm/messages.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("steer-queue");

export interface SteerInput {
  content: string;
  userPayload?: AgentUserPayload;
  runtimeImages?: AgentUserRuntimeImagePayload[];
  messageType?: string;
  visibility?: string;
  channelMessageId?: string | null;
  channelParentMessageId?: string | null;
  channelThreadId?: string | null;
  createdAt?: Date;
}

export class SessionSteerQueueRegistry {
  private readonly queues = new Map<string, SteerInput[]>();

  enqueue(input: {
    sessionId: string;
    content: string;
    userPayload?: AgentUserPayload;
    runtimeImages?: AgentUserRuntimeImagePayload[];
    messageType?: string;
    visibility?: string;
    channelMessageId?: string | null;
    channelParentMessageId?: string | null;
    channelThreadId?: string | null;
    createdAt?: Date;
  }): void {
    const queue = this.queues.get(input.sessionId) ?? [];
    queue.push({
      content: input.content,
      ...(input.userPayload == null ? {} : { userPayload: input.userPayload }),
      ...(input.runtimeImages == null ? {} : { runtimeImages: input.runtimeImages }),
      ...(input.messageType == null ? {} : { messageType: input.messageType }),
      ...(input.visibility == null ? {} : { visibility: input.visibility }),
      ...(input.channelMessageId === undefined
        ? {}
        : { channelMessageId: input.channelMessageId ?? null }),
      ...(input.channelParentMessageId === undefined
        ? {}
        : { channelParentMessageId: input.channelParentMessageId ?? null }),
      ...(input.channelThreadId === undefined
        ? {}
        : { channelThreadId: input.channelThreadId ?? null }),
      ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
    });
    this.queues.set(input.sessionId, queue);
    logger.debug("enqueued steer input", {
      sessionId: input.sessionId,
      queueLength: queue.length,
      persistedImageCount: input.userPayload?.images?.length ?? 0,
      runtimeImageCount: input.runtimeImages?.length ?? 0,
      channelMessageId: input.channelMessageId ?? null,
    });
  }

  drain(sessionId: string): SteerInput[] {
    const queue = this.queues.get(sessionId);
    if (queue == null || queue.length === 0) {
      return [];
    }

    this.queues.delete(sessionId);
    logger.debug("drained steer queue", {
      sessionId,
      drainedCount: queue.length,
      runtimeImageCount: queue.reduce((sum, item) => sum + (item.runtimeImages?.length ?? 0), 0),
    });
    return [...queue];
  }

  hasQueued(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.length ?? 0) > 0;
  }

  clear(sessionId: string): void {
    this.queues.delete(sessionId);
  }
}
