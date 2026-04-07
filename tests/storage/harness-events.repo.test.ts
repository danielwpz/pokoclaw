import { afterEach, describe, expect, test } from "vitest";

import { HarnessEventsRepo } from "@/src/storage/repos/harness-events.repo.js";
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

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES ('sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat', 'isolated', 'active', 0, '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z');

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_1', 'conv_1', 'branch_1',
      'cron', '0 * * * *', '{}', '2026-03-26T00:00:00.000Z', '2026-03-26T00:00:00.000Z'
    );

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id,
      execution_session_id, status, started_at
    ) VALUES (
      'task_1', 'cron', 'agent_1', 'conv_1', 'branch_1', 'cron_1',
      'sess_1', 'running', '2026-03-26T00:00:01.000Z'
    );
  `);
}

describe("harness events repo", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("creates and lists explicit user stop events by run id", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const repo = new HarnessEventsRepo(handle.storage.db);

    repo.create({
      id: "evt_1",
      eventType: "user_stop",
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      agentId: "agent_1",
      actor: "lark:default:ou_sender",
      sourceKind: "command",
      requestScope: "conversation",
      reasonText: "stop requested from lark command",
      createdAt: new Date("2026-03-26T00:00:03.000Z"),
    });

    repo.create({
      id: "evt_2",
      eventType: "user_stop",
      runId: "run_1",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      agentId: "agent_1",
      taskRunId: "task_1",
      cronJobId: "cron_1",
      actor: "lark:default:ou_sender",
      sourceKind: "button",
      requestScope: "run",
      reasonText: "stop requested from lark card action",
      detailsJson: '{"note":"explicit"}',
      createdAt: new Date("2026-03-26T00:00:04.000Z"),
    });

    expect(repo.listByRunId("run_1")).toMatchObject([
      {
        id: "evt_2",
        taskRunId: "task_1",
        cronJobId: "cron_1",
        sourceKind: "button",
        requestScope: "run",
        detailsJson: '{"note":"explicit"}',
      },
      {
        id: "evt_1",
        sourceKind: "command",
        requestScope: "conversation",
      },
    ]);
  });
});
