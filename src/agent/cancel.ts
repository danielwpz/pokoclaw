export interface SessionRunHandle {
  sessionId: string;
  signal: AbortSignal;
  finish: () => void;
}

export class SessionRunAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  begin(sessionId: string): SessionRunHandle {
    if (this.controllers.has(sessionId)) {
      throw new Error(`Session already has an active run: ${sessionId}`);
    }

    const controller = new AbortController();
    this.controllers.set(sessionId, controller);

    return {
      sessionId,
      signal: controller.signal,
      finish: () => {
        const current = this.controllers.get(sessionId);
        if (current === controller) {
          this.controllers.delete(sessionId);
        }
      },
    };
  }

  getSignal(sessionId: string): AbortSignal | null {
    return this.controllers.get(sessionId)?.signal ?? null;
  }

  isActive(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  cancel(sessionId: string, reason = "cancelled"): boolean {
    const controller = this.controllers.get(sessionId);
    if (controller == null) {
      return false;
    }

    controller.abort(reason);
    this.controllers.delete(sessionId);
    return true;
  }
}
