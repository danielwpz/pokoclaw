export interface SteerInput {
  content: string;
  createdAt?: Date;
}

export class SessionSteerQueueRegistry {
  private readonly queues = new Map<string, SteerInput[]>();

  enqueue(input: { sessionId: string; content: string; createdAt?: Date }): void {
    const queue = this.queues.get(input.sessionId) ?? [];
    queue.push({
      content: input.content,
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
