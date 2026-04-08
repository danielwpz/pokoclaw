import { afterEach, describe, expect, test, vi } from "vitest";

import { MinuteHeartbeat } from "@/src/runtime/minute-heartbeat.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("minute heartbeat", () => {
  test("dispatches an immediate floored tick, then aligns subsequent ticks to minute boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:30.250Z"));

    const received: string[] = [];
    const heartbeat = new MinuteHeartbeat();
    heartbeat.subscribe("test", async (tickAt) => {
      received.push(tickAt.toISOString());
    });

    heartbeat.start();
    await vi.runAllTicks();

    expect(received).toEqual(["2026-04-08T12:00:00.000Z"]);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(received).toEqual(["2026-04-08T12:00:00.000Z"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(received).toEqual(["2026-04-08T12:00:00.000Z", "2026-04-08T12:01:00.000Z"]);

    heartbeat.stop();
  });

  test("stop cancels future ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:10.000Z"));

    const received: string[] = [];
    const heartbeat = new MinuteHeartbeat();
    heartbeat.subscribe("test", (tickAt) => {
      received.push(tickAt.toISOString());
    });

    heartbeat.start();
    heartbeat.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).toEqual(["2026-04-08T12:00:00.000Z"]);
    expect(heartbeat.status()).toEqual({
      started: false,
      subscriberCount: 1,
    });
  });
});
