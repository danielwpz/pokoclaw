import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("runtime/event-bus");

export type RuntimeEventBusListener<TEvent> = (event: TEvent) => void | Promise<void>;

export class RuntimeEventBus<TEvent> {
  private readonly listeners = new Set<RuntimeEventBusListener<TEvent>>();

  subscribe(listener: RuntimeEventBusListener<TEvent>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: TEvent): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        void Promise.resolve(listener(event)).catch((error: unknown) => {
          logger.error("runtime event bus listener failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
