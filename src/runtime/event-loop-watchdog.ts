import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("runtime/event-loop-watchdog");

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WARN_LAG_MS = 2_000;
const DEFAULT_ERROR_LAG_MS = 10_000;

export interface RuntimeEventLoopWatchdogDependencies {
  now?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  intervalMs?: number;
  warnLagMs?: number;
  errorLagMs?: number;
}

export interface RuntimeEventLoopWatchdogStatus {
  started: boolean;
  intervalMs: number;
  warnLagMs: number;
  errorLagMs: number;
  expectedNextTickAt: string | null;
}

export class RuntimeEventLoopWatchdog {
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly intervalMs: number;
  private readonly warnLagMs: number;
  private readonly errorLagMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private expectedNextTickAt: Date | null = null;

  constructor(deps: RuntimeEventLoopWatchdogDependencies = {}) {
    this.now = deps.now ?? (() => new Date());
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.warnLagMs = deps.warnLagMs ?? DEFAULT_WARN_LAG_MS;
    this.errorLagMs = deps.errorLagMs ?? DEFAULT_ERROR_LAG_MS;
  }

  start(): void {
    if (this.timer != null) {
      logger.debug("event loop watchdog start skipped because it is already running");
      return;
    }

    this.expectedNextTickAt = new Date(this.now().getTime() + this.intervalMs);
    this.timer = this.setIntervalFn(() => this.check(), this.intervalMs);
    const timerWithUnref = this.timer as { unref?: () => void };
    if (typeof timerWithUnref.unref === "function") {
      timerWithUnref.unref();
    }

    logger.info("event loop watchdog started", {
      intervalMs: this.intervalMs,
      warnLagMs: this.warnLagMs,
      errorLagMs: this.errorLagMs,
      expectedNextTickAt: this.expectedNextTickAt.toISOString(),
    });
  }

  stop(): void {
    if (this.timer == null) {
      logger.debug("event loop watchdog stop skipped because it is already idle");
      return;
    }

    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.expectedNextTickAt = null;
    logger.info("event loop watchdog stopped");
  }

  status(): RuntimeEventLoopWatchdogStatus {
    return {
      started: this.timer != null,
      intervalMs: this.intervalMs,
      warnLagMs: this.warnLagMs,
      errorLagMs: this.errorLagMs,
      expectedNextTickAt: this.expectedNextTickAt?.toISOString() ?? null,
    };
  }

  private check(): void {
    const actual = this.now();
    const expected = this.expectedNextTickAt;
    const lagMs = expected == null ? 0 : actual.getTime() - expected.getTime();
    this.expectedNextTickAt = new Date(actual.getTime() + this.intervalMs);

    if (lagMs >= this.errorLagMs) {
      logger.error("event loop lag exceeded error threshold", {
        lagMs,
        actualTickAt: actual.toISOString(),
        expectedTickAt: expected?.toISOString() ?? null,
        nextExpectedTickAt: this.expectedNextTickAt.toISOString(),
      });
      return;
    }

    if (lagMs >= this.warnLagMs) {
      logger.warn("event loop lag exceeded warning threshold", {
        lagMs,
        actualTickAt: actual.toISOString(),
        expectedTickAt: expected?.toISOString() ?? null,
        nextExpectedTickAt: this.expectedNextTickAt.toISOString(),
      });
    }
  }
}
