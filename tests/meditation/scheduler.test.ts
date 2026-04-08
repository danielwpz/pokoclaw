import { afterEach, describe, expect, test, vi } from "vitest";

import { MeditationScheduler } from "@/src/meditation/scheduler.js";
import { MeditationStateRepo } from "@/src/storage/repos/meditation-state.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("meditation scheduler", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("starts one run when the heartbeat tick matches the configured cron", async () => {
    handle = await createTestDatabase(import.meta.url);

    const now = new Date("2026-04-08T00:00:00.000Z");
    const runner = {
      runOnce: vi.fn(async () => ({ skipped: false, bucketsExecuted: 1 })),
    };
    const scheduler = new MeditationScheduler({
      config: {
        meditation: {
          enabled: true,
          cron: "* * * * *",
        },
      },
      state: new MeditationStateRepo(handle.storage.db),
      runner,
      now: () => now,
    });

    scheduler.start();
    scheduler.onHeartbeatTick(new Date("2026-04-08T00:00:00.000Z"));
    await flushMicrotasks();

    expect(runner.runOnce).toHaveBeenCalledOnce();
    expect(new MeditationStateRepo(handle.storage.db).get()).toMatchObject({
      running: false,
      lastStartedAt: "2026-04-08T00:00:00.000Z",
      lastFinishedAt: "2026-04-08T00:00:00.000Z",
      lastSuccessAt: "2026-04-08T00:00:00.000Z",
      lastStatus: "completed",
    });
  });

  test("does not run twice for the same minute", async () => {
    handle = await createTestDatabase(import.meta.url);

    const runner = {
      runOnce: vi.fn(async () => ({ skipped: false, bucketsExecuted: 1 })),
    };
    const scheduler = new MeditationScheduler({
      config: {
        meditation: {
          enabled: true,
          cron: "* * * * *",
        },
      },
      state: new MeditationStateRepo(handle.storage.db),
      runner,
      now: () => new Date("2026-04-08T00:00:00.000Z"),
    });

    scheduler.start();
    scheduler.onHeartbeatTick(new Date("2026-04-08T00:00:00.000Z"));
    await flushMicrotasks();
    scheduler.onHeartbeatTick(new Date("2026-04-08T00:00:00.000Z"));
    await flushMicrotasks();

    expect(runner.runOnce).toHaveBeenCalledTimes(1);
  });

  test("does nothing when meditation is disabled", async () => {
    handle = await createTestDatabase(import.meta.url);

    const runner = {
      runOnce: vi.fn(async () => ({ skipped: false, bucketsExecuted: 1 })),
    };
    const scheduler = new MeditationScheduler({
      config: {
        meditation: {
          enabled: false,
          cron: "0 0 * * *",
        },
      },
      state: new MeditationStateRepo(handle.storage.db),
      runner,
      now: () => new Date("2026-04-08T00:00:00.000Z"),
    });

    scheduler.start();
    scheduler.onHeartbeatTick(new Date("2026-04-08T00:00:00.000Z"));
    await flushMicrotasks();

    expect(runner.runOnce).not.toHaveBeenCalled();
    expect(new MeditationStateRepo(handle.storage.db).get()).toBeNull();
  });
});
