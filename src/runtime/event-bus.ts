/**
 * Lightweight async pub/sub bus for outbound runtime facts.
 *
 * Runtime and orchestration publish channel-agnostic event envelopes here.
 * Channel adapters subscribe and render according to platform capabilities.
 */
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("runtime/event-bus");
const PENDING_DISPATCH_WARN_THRESHOLD = 500;
const PENDING_DISPATCH_ERROR_THRESHOLD = 5_000;
const DISPATCH_SLOW_WARN_MS = 1_000;
const BACKLOG_LOG_INTERVAL_MS = 5_000;

export type RuntimeEventBusListener<TEvent> = (event: TEvent) => void | Promise<void>;

export class RuntimeEventBus<TEvent> {
  private readonly listeners = new Set<RuntimeEventBusListener<TEvent>>();
  private pendingDispatches = 0;
  private publishedDispatches = 0;
  private completedDispatches = 0;
  private failedDispatches = 0;
  private lastBacklogLogAt = 0;

  subscribe(listener: RuntimeEventBusListener<TEvent>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: TEvent): void {
    for (const listener of this.listeners) {
      this.pendingDispatches += 1;
      this.publishedDispatches += 1;
      this.logBacklogIfNeeded(event);
      setImmediate(() => {
        const startedAt = Date.now();
        void Promise.resolve(listener(event))
          .catch((error: unknown) => {
            this.failedDispatches += 1;
            logger.error("runtime event bus listener failed", {
              ...describeRuntimeEventForLog(event),
              error: error instanceof Error ? error.message : String(error),
              pendingDispatches: this.pendingDispatches,
              publishedDispatches: this.publishedDispatches,
              completedDispatches: this.completedDispatches,
              failedDispatches: this.failedDispatches,
            });
          })
          .finally(() => {
            this.pendingDispatches = Math.max(0, this.pendingDispatches - 1);
            this.completedDispatches += 1;
            const durationMs = Date.now() - startedAt;
            if (durationMs >= DISPATCH_SLOW_WARN_MS) {
              logger.warn("runtime event bus listener dispatch was slow", {
                ...describeRuntimeEventForLog(event),
                durationMs,
                pendingDispatches: this.pendingDispatches,
                publishedDispatches: this.publishedDispatches,
                completedDispatches: this.completedDispatches,
                failedDispatches: this.failedDispatches,
              });
            }
          });
      });
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private logBacklogIfNeeded(event: TEvent): void {
    if (this.pendingDispatches < PENDING_DISPATCH_WARN_THRESHOLD) {
      return;
    }
    const now = Date.now();
    if (now - this.lastBacklogLogAt < BACKLOG_LOG_INTERVAL_MS) {
      return;
    }
    this.lastBacklogLogAt = now;
    const log =
      this.pendingDispatches >= PENDING_DISPATCH_ERROR_THRESHOLD ? logger.error : logger.warn;
    log("runtime event bus dispatch backlog is high", {
      ...describeRuntimeEventForLog(event),
      pendingDispatches: this.pendingDispatches,
      listenerCount: this.listeners.size,
      publishedDispatches: this.publishedDispatches,
      completedDispatches: this.completedDispatches,
      failedDispatches: this.failedDispatches,
    });
  }
}

function describeRuntimeEventForLog(event: unknown): Record<string, unknown> {
  const envelope = asRecord(event);
  if (envelope == null) {
    return {
      eventValueType: typeof event,
    };
  }

  const eventRecord = asRecord(envelope.event);
  const runRecord = asRecord(envelope.run);
  const sessionRecord = asRecord(envelope.session);
  const taskRunRecord = asRecord(envelope.taskRun);

  return {
    envelopeKind: readString(envelope.kind),
    eventType: readString(eventRecord?.type),
    runId: readString(runRecord?.runId),
    sessionId: readString(sessionRecord?.sessionId),
    taskRunId: readString(taskRunRecord?.taskRunId),
    taskRunType: readString(taskRunRecord?.runType),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
