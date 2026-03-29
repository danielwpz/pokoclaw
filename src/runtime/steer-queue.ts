/**
 * Session-local steer queue.
 *
 * Stores deferred user steering messages while a run is busy and lets runtime
 * replay them in order once the current execution stage allows it.
 */
export interface SteerInput {
  content: string;
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
  }

  drain(sessionId: string): SteerInput[] {
    const queue = this.queues.get(sessionId);
    if (queue == null || queue.length === 0) {
      return [];
    }

    this.queues.delete(sessionId);
    return [...queue];
  }

  hasQueued(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.length ?? 0) > 0;
  }

  clear(sessionId: string): void {
    this.queues.delete(sessionId);
  }
}
