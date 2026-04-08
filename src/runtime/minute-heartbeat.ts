import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("runtime/minute-heartbeat");

const DEFAULT_INTERVAL_MS = 60_000;

export type MinuteHeartbeatListener = (tickAt: Date) => void | Promise<void>;

export interface MinuteHeartbeatDependencies {
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  intervalMs?: number;
}

export interface MinuteHeartbeatStatus {
  started: boolean;
  subscriberCount: number;
}

export class MinuteHeartbeat {
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly intervalMs: number;

  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Map<string, MinuteHeartbeatListener>();

  constructor(deps: MinuteHeartbeatDependencies = {}) {
    this.now = deps.now ?? (() => new Date());
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  subscribe(name: string, listener: MinuteHeartbeatListener): () => void {
    this.listeners.set(name, listener);
    logger.debug("registered minute heartbeat subscriber", {
      subscriber: name,
      subscriberCount: this.listeners.size,
    });
    return () => {
      const deleted = this.listeners.delete(name);
      if (deleted) {
        logger.debug("unregistered minute heartbeat subscriber", {
          subscriber: name,
          subscriberCount: this.listeners.size,
        });
      }
    };
  }

  start(): void {
    if (this.started) {
      logger.debug("minute heartbeat start skipped because it is already running");
      return;
    }

    this.started = true;
    logger.info("minute heartbeat started", {
      intervalMs: this.intervalMs,
      subscriberCount: this.listeners.size,
    });

    this.dispatchTick(resolveHeartbeatTickAt(this.now()));
    this.scheduleNextTick();
  }

  stop(): void {
    if (!this.started && this.timer == null) {
      logger.debug("minute heartbeat stop skipped because it is already idle");
      return;
    }

    this.started = false;
    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }

    logger.info("minute heartbeat stopped", {
      subscriberCount: this.listeners.size,
    });
  }

  status(): MinuteHeartbeatStatus {
    return {
      started: this.started,
      subscriberCount: this.listeners.size,
    };
  }

  triggerNow(at: Date = this.now()): void {
    this.dispatchTick(resolveHeartbeatTickAt(at));
  }

  private scheduleNextTick(): void {
    if (!this.started) {
      return;
    }

    const nowMs = this.now().getTime();
    const remainder = nowMs % this.intervalMs;
    const delayMs = remainder === 0 ? this.intervalMs : this.intervalMs - remainder;

    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }

    logger.debug("scheduled next minute heartbeat tick", {
      delayMs,
    });
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.dispatchTick(resolveHeartbeatTickAt(this.now()));
      if (this.started) {
        this.scheduleNextTick();
      }
    }, delayMs);
  }

  private dispatchTick(tickAt: Date): void {
    logger.debug("dispatching minute heartbeat tick", {
      tickAt: tickAt.toISOString(),
      subscriberCount: this.listeners.size,
    });
    for (const [name, listener] of this.listeners) {
      void Promise.resolve(listener(tickAt)).catch((error: unknown) => {
        logger.error("minute heartbeat subscriber failed", {
          subscriber: name,
          tickAt: tickAt.toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}

function resolveHeartbeatTickAt(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      0,
      0,
    ),
  );
}
