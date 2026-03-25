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
});
