const DEFAULT_PENDING_TTL_MS = 6 * 60 * 60 * 1000;

interface PendingReaction {
  messageId: string;
  reactionId: string;
  emojiType: string;
  createdAtMs: number;
}

export class LarkSteerReactionState {
  private readonly pending = new Map<string, PendingReaction>();

  constructor(private readonly ttlMs: number = DEFAULT_PENDING_TTL_MS) {}

  rememberPendingReaction(input: {
    installationId: string;
    messageId: string;
    reactionId: string;
    emojiType: string;
  }): void {
    this.sweepExpired(Date.now());
    this.pending.set(this.buildKey(input.installationId, input.messageId), {
      messageId: input.messageId,
      reactionId: input.reactionId,
      emojiType: input.emojiType,
      createdAtMs: Date.now(),
    });
  }

  takePendingReaction(input: {
    installationId: string;
    messageId: string;
  }): PendingReaction | null {
    this.sweepExpired(Date.now());
    const key = this.buildKey(input.installationId, input.messageId);
    const value = this.pending.get(key) ?? null;
    if (value != null) {
      this.pending.delete(key);
    }
    return value;
  }

  private buildKey(installationId: string, messageId: string): string {
    return `${installationId}:${messageId}`;
  }

  private sweepExpired(now: number): void {
    for (const [key, value] of this.pending) {
      if (now - value.createdAtMs > this.ttlMs) {
        this.pending.delete(key);
      }
    }
  }
}
