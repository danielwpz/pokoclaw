import { afterEach, describe, expect, test } from "vitest";
import { prepareMeditationBucketInput } from "@/src/meditation/bucket-prep.js";
import { buildMeditationBuckets } from "@/src/meditation/clustering.js";
import { MeditationReadModel } from "@/src/meditation/read-model.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');

    INSERT INTO agents (
      id, conversation_id, kind, display_name, description, workdir, created_at
    ) VALUES (
      'agent_sub_1', 'conv_1', 'sub', 'Atlas Frontend', 'Handles atlas-web frontend tasks.', '/repo/atlas-web', '2026-04-01T00:00:00.000Z'
    );

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, compact_summary, created_at, updated_at
    ) VALUES (
      'sess_1', 'conv_1', 'branch_1', 'agent_sub_1', 'task', 'Recent atlas summary', '2026-04-01T00:00:00.000Z', '2026-04-08T00:00:00.000Z'
    );

    INSERT INTO harness_events (
      id, event_type, run_id, session_id, conversation_id, branch_id, agent_id,
      source_kind, request_scope, created_at, actor
    ) VALUES (
      'evt_recent', 'user_stop', 'run_recent', 'sess_1', 'conv_1', 'branch_1', 'agent_sub_1',
      'button', 'run', '2026-04-07T12:00:00.000Z', 'lark:user'
    );

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_sub_1', 'conv_1', 'branch_1',
      'cron', '0 0 * * *', '{}', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
    );

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
      status, description, result_summary, error_text, started_at, finished_at
    ) VALUES (
      'task_fail_1', 'cron', 'agent_sub_1', 'conv_1', 'branch_1', 'cron_1', 'sess_1',
      'failed', 'nightly sync', 'failed badly', 'boom', '2026-04-07T12:15:00.000Z', '2026-04-07T12:16:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES
      (
        'msg_stop_before', 'sess_1', 1, 'assistant', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"before stop"}]}', '2026-04-07T11:59:00.000Z'
      ),
      (
        'msg_stop_after', 'sess_1', 2, 'user', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"after stop"}]}', '2026-04-07T12:01:00.000Z'
      ),
      (
        'msg_task_before', 'sess_1', 3, 'assistant', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"before task failure"}]}', '2026-04-07T12:15:30.000Z'
      ),
      (
        'msg_task_after', 'sess_1', 4, 'assistant', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"after task failure"}]}', '2026-04-07T12:16:30.000Z'
      ),
      (
        'msg_tool_before', 'sess_1', 9, 'user', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"before tool burst"}]}', '2026-04-07T12:20:30.000Z'
      ),
      (
        'msg_tool_fail_1', 'sess_1', 10, 'tool', 'tool_result', 'hidden',
        '{"toolName":"bash","isError":true,"content":[{"type":"text","text":"Permission request denied."}],"details":{"code":"permission_denied","request":{"scopes":[{"kind":"bash.full_access"}],"prefix":["lark-cli"]}}}',
        '2026-04-07T12:21:00.000Z'
      ),
      (
        'msg_tool_fail_2', 'sess_1', 11, 'tool', 'tool_result', 'hidden',
        '{"toolName":"bash","isError":true,"content":[{"type":"text","text":"Permission request denied."}],"details":{"code":"permission_denied","request":{"scopes":[{"kind":"bash.full_access"}],"prefix":["lark-cli"]}}}',
        '2026-04-07T12:21:30.000Z'
      ),
      (
        'msg_tool_after', 'sess_1', 12, 'assistant', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"after tool burst"}]}', '2026-04-07T12:22:00.000Z'
      );
  `);
}

describe("prepareMeditationBucketInput", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("attaches profile and local context packages for each cluster kind", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const readModel = new MeditationReadModel(handle.storage.db);

    const buckets = buildMeditationBuckets({
      stops: readModel.listStopFacts("2026-04-07T00:00:00.000Z", "2026-04-08T00:00:00.000Z"),
      taskFailures: readModel.listTaskFailureFacts(
        "2026-04-07T00:00:00.000Z",
        "2026-04-08T00:00:00.000Z",
      ),
      failedToolResults: readModel.listFailedToolResults(
        "2026-04-07T00:00:00.000Z",
        "2026-04-08T00:00:00.000Z",
      ),
    });
    const bucket = buckets[0];
    if (bucket == null) {
      throw new Error("expected one prepared bucket");
    }

    const prepared = prepareMeditationBucketInput({
      bucket,
      readModel,
    });

    expect(prepared.profile).toMatchObject({
      displayName: "Atlas Frontend",
      description: "Handles atlas-web frontend tasks.",
      workdir: "/repo/atlas-web",
      compactSummary: "Recent atlas summary",
    });

    const stopCluster = prepared.clusters.find((cluster) => cluster.kind === "stop");
    const taskFailureCluster = prepared.clusters.find((cluster) => cluster.kind === "task_failure");
    const toolBurstCluster = prepared.clusters.find((cluster) => cluster.kind === "tool_burst");
    const toolRepeatCluster = prepared.clusters.find((cluster) => cluster.kind === "tool_repeat");

    expect(stopCluster).toBeDefined();
    expect(stopCluster?.contextMessages.map((message) => message.id)).toEqual([
      "msg_stop_before",
      "msg_stop_after",
    ]);

    expect(taskFailureCluster).toBeDefined();
    expect(taskFailureCluster?.contextMessages.map((message) => message.id)).toEqual([
      "msg_task_before",
      "msg_task_after",
    ]);

    expect(toolBurstCluster).toBeDefined();
    expect(toolBurstCluster?.contextMessages.map((message) => message.id)).toEqual([
      "msg_tool_before",
      "msg_tool_fail_1",
      "msg_tool_fail_2",
      "msg_tool_after",
    ]);

    expect(toolRepeatCluster).toBeDefined();
    expect(toolRepeatCluster?.examples).toHaveLength(2);
    expect(
      toolRepeatCluster?.examples[0]?.messageWindow.some(
        (message) => message.id === "msg_tool_fail_1",
      ),
    ).toBe(true);
    expect(
      toolRepeatCluster?.examples[1]?.messageWindow.some(
        (message) => message.id === "msg_tool_fail_2",
      ),
    ).toBe(true);
  });
});
