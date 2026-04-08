import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_MEDITATION_STATE_ID,
  MeditationStateRepo,
} from "@/src/storage/repos/meditation-state.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("meditation state repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates the default state row lazily", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MeditationStateRepo(handle.storage.db);

    const state = repo.getOrCreateDefault(new Date("2026-04-08T00:00:00.000Z"));

    expect(state).toMatchObject({
      id: DEFAULT_MEDITATION_STATE_ID,
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      updatedAt: "2026-04-08T00:00:00.000Z",
    });
  });

  test("tracks started and finished lifecycle fields", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MeditationStateRepo(handle.storage.db);

    repo.markStarted({
      startedAt: new Date("2026-04-08T00:00:10.000Z"),
    });
    expect(repo.get()).toMatchObject({
      id: DEFAULT_MEDITATION_STATE_ID,
      running: true,
      lastStartedAt: "2026-04-08T00:00:10.000Z",
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastStatus: null,
      updatedAt: "2026-04-08T00:00:10.000Z",
    });

    repo.markFinished({
      status: "completed",
      finishedAt: new Date("2026-04-08T00:00:20.000Z"),
      markSuccess: true,
    });
    expect(repo.get()).toMatchObject({
      id: DEFAULT_MEDITATION_STATE_ID,
      running: false,
      lastStartedAt: "2026-04-08T00:00:10.000Z",
      lastFinishedAt: "2026-04-08T00:00:20.000Z",
      lastSuccessAt: "2026-04-08T00:00:20.000Z",
      lastStatus: "completed",
      updatedAt: "2026-04-08T00:00:20.000Z",
    });
  });

  test("clears stale running state without touching last success", async () => {
    handle = await createTestDatabase(import.meta.url);
    const repo = new MeditationStateRepo(handle.storage.db);

    repo.markStarted({
      startedAt: new Date("2026-04-08T00:00:10.000Z"),
    });
    repo.markFinished({
      status: "completed",
      finishedAt: new Date("2026-04-08T00:00:20.000Z"),
      markSuccess: true,
    });
    repo.markStarted({
      startedAt: new Date("2026-04-08T02:00:00.000Z"),
    });

    const cleared = repo.clearStaleRunning({
      now: new Date("2026-04-08T05:00:00.000Z"),
      staleBefore: new Date("2026-04-08T03:00:00.000Z"),
    });

    expect(cleared).toBe(1);
    expect(repo.get()).toMatchObject({
      id: DEFAULT_MEDITATION_STATE_ID,
      running: false,
      lastStartedAt: "2026-04-08T02:00:00.000Z",
      lastFinishedAt: "2026-04-08T05:00:00.000Z",
      lastSuccessAt: "2026-04-08T00:00:20.000Z",
      lastStatus: "stale",
      updatedAt: "2026-04-08T05:00:00.000Z",
    });
  });
});
