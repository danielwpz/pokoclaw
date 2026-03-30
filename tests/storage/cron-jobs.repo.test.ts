import { afterEach, describe, expect, test } from "vitest";

import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-26T00:00:00.000Z');

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, context_mode, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_1', 'conv_1', 'branch_1',
      'cron', '0 * * * *', 'group', '{"job":"daily-finance"}',
      '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'
    );
  `);
}

describe("cron jobs repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("reads cron jobs by id", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new CronJobsRepo(handle.storage.db);
    expect(repo.getById("cron_1")).toMatchObject({
      id: "cron_1",
      ownerAgentId: "agent_1",
      targetConversationId: "conv_1",
      targetBranchId: "branch_1",
      contextMode: "group",
      payloadJson: '{"job":"daily-finance"}',
    });
    expect(repo.getById("missing_cron")).toBeNull();
  });

  test("claims due jobs only when enabled and not already running", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new CronJobsRepo(handle.storage.db);
    repo.update({
      id: "cron_1",
      nextRunAt: new Date("2026-03-26T01:00:00.000Z"),
    });

    const claimed = repo.claimDueRun({
      id: "cron_1",
      now: new Date("2026-03-26T01:05:00.000Z"),
      nextRunAt: new Date("2026-03-26T02:00:00.000Z"),
    });
    expect(claimed).toMatchObject({
      id: "cron_1",
      runningAt: "2026-03-26T01:05:00.000Z",
      nextRunAt: "2026-03-26T02:00:00.000Z",
    });

    const duplicate = repo.claimDueRun({
      id: "cron_1",
      now: new Date("2026-03-26T01:06:00.000Z"),
      nextRunAt: new Date("2026-03-26T03:00:00.000Z"),
    });
    expect(duplicate).toBeNull();
  });

  test("manual claim can run disabled jobs without changing schedule", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new CronJobsRepo(handle.storage.db);
    repo.update({
      id: "cron_1",
      enabled: false,
      nextRunAt: new Date("2026-03-26T05:00:00.000Z"),
    });

    const claimed = repo.claimManualRun({
      id: "cron_1",
      now: new Date("2026-03-26T01:05:00.000Z"),
    });

    expect(claimed).toMatchObject({
      id: "cron_1",
      runningAt: "2026-03-26T01:05:00.000Z",
      nextRunAt: "2026-03-26T05:00:00.000Z",
      enabled: false,
    });
  });

  test("clearStaleRunning marks stale claims as missed", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new CronJobsRepo(handle.storage.db);
    repo.update({
      id: "cron_1",
      nextRunAt: new Date("2026-03-26T05:00:00.000Z"),
    });
    repo.claimManualRun({
      id: "cron_1",
      now: new Date("2026-03-26T01:05:00.000Z"),
    });

    const cleared = repo.clearStaleRunning({
      now: new Date("2026-03-26T05:00:00.000Z"),
      staleBefore: new Date("2026-03-26T03:00:00.000Z"),
    });

    expect(cleared).toBe(1);
    expect(repo.getById("cron_1")).toMatchObject({
      runningAt: null,
      lastStatus: "missed",
    });
  });

  test("soft-deleted cron jobs stay in storage but disappear from active lookups and claims", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new CronJobsRepo(handle.storage.db);
    repo.softDelete({
      id: "cron_1",
      deletedAt: new Date("2026-03-26T02:00:00.000Z"),
    });

    expect(repo.getById("cron_1")).toBeNull();
    expect(repo.getByIdIncludingDeleted("cron_1")).toMatchObject({
      id: "cron_1",
      enabled: false,
      nextRunAt: null,
      deletedAt: "2026-03-26T02:00:00.000Z",
    });
    expect(repo.list({ includeDisabled: true })).toEqual([]);
    expect(repo.listDue(new Date("2026-03-26T03:00:00.000Z"))).toEqual([]);
    expect(
      repo.claimManualRun({
        id: "cron_1",
        now: new Date("2026-03-26T03:00:00.000Z"),
      }),
    ).toBeNull();
  });

  test("one-shot jobs disable themselves for every terminal settle status", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const repo = new CronJobsRepo(handle.storage.db);
    repo.update({
      id: "cron_1",
      scheduleKind: "at",
      scheduleValue: "2026-03-26T01:00:00.000Z",
      enabled: true,
      nextRunAt: new Date("2026-03-26T02:00:00.000Z"),
    });

    for (const status of ["failed", "blocked", "cancelled", "missed"] as const) {
      const finishedAt = new Date("2026-03-26T03:00:00.000Z");
      const settled = repo.completeRun({
        id: "cron_1",
        finishedAt,
        status,
        lastOutput: `${status} output`,
        nextRunAt: new Date("2026-03-26T04:00:00.000Z"),
      });

      expect(settled).toMatchObject({
        id: "cron_1",
        enabled: false,
        nextRunAt: null,
        lastStatus: status,
        lastOutput: `${status} output`,
      });

      repo.update({
        id: "cron_1",
        enabled: true,
        nextRunAt: new Date("2026-03-26T02:00:00.000Z"),
      });
    }
  });
});
