import { describe, expect, test, vi } from "vitest";

import { RuntimeEventBus } from "@/src/runtime/event-bus.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RuntimeEventBus", () => {
  test("publishes events to subscribed listeners asynchronously", async () => {
    const bus = new RuntimeEventBus<{ id: string }>();
    const listener = vi.fn();

    bus.subscribe(listener);
    bus.publish({ id: "evt_1" });

    expect(listener).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ id: "evt_1" });
  });

  test("unsubscribe removes the listener", async () => {
    const bus = new RuntimeEventBus<{ id: string }>();
    const listener = vi.fn();

    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    bus.publish({ id: "evt_2" });

    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });
});
