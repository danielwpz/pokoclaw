import { describe, expect, test } from "vitest";

import { resolveMeditationWindow } from "@/src/meditation/window.js";

describe("resolveMeditationWindow", () => {
  test("uses last success as the window start when it is inside the lookback horizon", () => {
    const window = resolveMeditationWindow({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
      lastSuccessAt: "2026-04-07T12:00:00.000Z",
      calendarContext: {
        currentDate: "2026-04-08",
        timezone: "Asia/Shanghai",
      },
    });

    expect(window).toMatchObject({
      startAt: "2026-04-07T12:00:00.000Z",
      endAt: "2026-04-08T00:00:00.000Z",
      lastSuccessAt: "2026-04-07T12:00:00.000Z",
      localDate: "2026-04-08",
      timezone: "Asia/Shanghai",
      clippedByLookback: false,
    });
  });

  test("clips the window to the max lookback horizon when last success is too old", () => {
    const window = resolveMeditationWindow({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
      lastSuccessAt: "2026-03-01T00:00:00.000Z",
      calendarContext: {
        currentDate: "2026-04-08",
        timezone: "UTC",
      },
    });

    expect(window).toMatchObject({
      startAt: "2026-04-01T00:00:00.000Z",
      endAt: "2026-04-08T00:00:00.000Z",
      lastSuccessAt: "2026-03-01T00:00:00.000Z",
      clippedByLookback: true,
    });
  });

  test("falls back to the max lookback horizon when there is no previous success", () => {
    const window = resolveMeditationWindow({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
      lastSuccessAt: null,
      calendarContext: {
        currentDate: "2026-04-08",
        timezone: "UTC",
      },
    });

    expect(window).toMatchObject({
      startAt: "2026-04-01T00:00:00.000Z",
      endAt: "2026-04-08T00:00:00.000Z",
      lastSuccessAt: null,
      clippedByLookback: true,
    });
  });

  test("clamps an invalid future last success timestamp to the current tick", () => {
    const window = resolveMeditationWindow({
      tickAt: new Date("2026-04-08T00:00:00.000Z"),
      lastSuccessAt: "2026-04-09T00:00:00.000Z",
      calendarContext: {
        currentDate: "2026-04-08",
        timezone: "UTC",
      },
    });

    expect(window).toMatchObject({
      startAt: "2026-04-08T00:00:00.000Z",
      endAt: "2026-04-08T00:00:00.000Z",
      lastSuccessAt: "2026-04-09T00:00:00.000Z",
      clippedByLookback: false,
    });
  });
});
