export interface SessionRunHandle {
  sessionId: string;
  signal: AbortSignal;
  finish: () => void;
}

// Tracks the single active run per session and exposes abort signals for that
// run. This registry is intentionally tiny: lane/dispatcher owns ingress
// serialization, while this module only answers "is there a live run to abort?"
// and ensures the loop can cooperatively stop.
export class SessionRunAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  // Claim the active-run slot for a session before async work begins.
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
