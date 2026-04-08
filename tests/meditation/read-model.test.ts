import { afterEach, describe, expect, test } from "vitest";

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
      'sess_pref', 'conv_1', 'branch_1', 'agent_sub_1', 'task', 'Preferred compact summary', '2026-04-01T00:00:00.000Z', '2026-04-08T00:00:00.000Z'
    );

    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, compact_summary, created_at, updated_at
    ) VALUES (
      'sess_fallback', 'conv_1', 'branch_1', 'agent_sub_1', 'task', 'Fallback summary', '2026-04-01T00:00:00.000Z', '2026-04-07T00:00:00.000Z'
    );

    INSERT INTO harness_events (
      id, event_type, run_id, session_id, conversation_id, branch_id, agent_id,
      source_kind, request_scope, created_at, actor
    ) VALUES (
      'evt_stop_1', 'user_stop', 'run_1', 'sess_pref', 'conv_1', 'branch_1', 'agent_sub_1',
      'button', 'run', '2026-04-08T00:10:00.000Z', 'lark:user'
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
      'task_fail_1', 'cron', 'agent_sub_1', 'conv_1', 'branch_1', 'cron_1', 'sess_pref',
      'failed', 'nightly sync', 'failed badly', 'boom', '2026-04-08T00:15:00.000Z', '2026-04-08T00:16:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES (
      'msg_user_1', 'sess_pref', 1, 'user', 'text', 'user_visible',
      '{"content":[{"type":"text","text":"please check"}]}', '2026-04-08T00:20:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES (
      'msg_tool_fail_1', 'sess_pref', 2, 'tool', 'tool_result', 'hidden',
      '{"toolName":"bash","isError":true,"content":[{"type":"text","text":"Permission request denied."}],"details":{"code":"permission_denied","request":{"scopes":[{"kind":"bash.full_access"}],"prefix":["lark-cli"]}}}',
      '2026-04-08T00:21:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES (
      'msg_tool_ok_1', 'sess_pref', 3, 'tool', 'tool_result', 'hidden',
      '{"toolName":"bash","isError":false,"content":[{"type":"text","text":"ok"}]}',
      '2026-04-08T00:22:00.000Z'
    );

    INSERT INTO messages (
      id, session_id, seq, role, message_type, visibility, payload_json, created_at
    ) VALUES (
      'msg_assistant_1', 'sess_pref', 4, 'assistant', 'text', 'user_visible',
      '{"content":[{"type":"text","text":"done"}]}', '2026-04-08T00:23:00.000Z'
    );
  `);
}

describe("meditation read model", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("loads stop facts and task failure facts inside a window", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const readModel = new MeditationReadModel(handle.storage.db);

    expect(readModel.listStopFacts("2026-04-08T00:00:00.000Z", "2026-04-08T00:59:59.000Z")).toEqual(
      [
        {
          runId: "run_1",
          sessionId: "sess_pref",
          agentId: "agent_sub_1",
          taskRunId: null,
          conversationId: "conv_1",
          branchId: "branch_1",
          createdAt: "2026-04-08T00:10:00.000Z",
          sourceKind: "button",
          requestScope: "run",
        },
      ],
    );

    expect(
      readModel.listTaskFailureFacts("2026-04-08T00:00:00.000Z", "2026-04-08T00:59:59.000Z"),
    ).toMatchObject([
      {
        id: "task_fail_1",
        ownerAgentId: "agent_sub_1",
        executionSessionId: "sess_pref",
        status: "failed",
        description: "nightly sync",
        resultSummary: "failed badly",
        errorText: "boom",
      },
    ]);
  });

  test("loads failed tool results and extracts structured fields", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const readModel = new MeditationReadModel(handle.storage.db);

    expect(
      readModel.listFailedToolResults("2026-04-08T00:00:00.000Z", "2026-04-08T00:59:59.000Z"),
    ).toEqual([
      {
        id: "msg_tool_fail_1",
        sessionId: "sess_pref",
        ownerAgentId: "agent_sub_1",
        seq: 2,
        createdAt: "2026-04-08T00:21:00.000Z",
        toolName: "bash",
        detailsCode: "permission_denied",
        requestScopeKind: "bash.full_access",
        requestPrefix0: "lark-cli",
        contentText: "Permission request denied.",
      },
    ]);
  });

  test("loads local message windows around a seq", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const readModel = new MeditationReadModel(handle.storage.db);

    expect(readModel.listSessionMessageWindow("sess_pref", 2, 1, 1)).toMatchObject([
      { id: "msg_user_1", seq: 1, role: "user" },
      { id: "msg_tool_fail_1", seq: 2, role: "tool", messageType: "tool_result" },
      { id: "msg_tool_ok_1", seq: 3, role: "tool", messageType: "tool_result" },
    ]);
  });

  test("loads local message windows around a timestamp", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO messages (
        id, session_id, seq, role, message_type, visibility, payload_json, created_at
      ) VALUES (
        'msg_before_time_1', 'sess_pref', 100, 'assistant', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"before stop"}]}', '2026-04-08T00:09:00.000Z'
      );

      INSERT INTO messages (
        id, session_id, seq, role, message_type, visibility, payload_json, created_at
      ) VALUES (
        'msg_after_time_1', 'sess_pref', 101, 'user', 'text', 'user_visible',
        '{"content":[{"type":"text","text":"after stop"}]}', '2026-04-08T00:11:00.000Z'
      );
    `);
    const readModel = new MeditationReadModel(handle.storage.db);

    expect(
      readModel.listSessionMessageWindowByTime("sess_pref", "2026-04-08T00:10:00.000Z", 1, 1),
    ).toMatchObject([
      { id: "msg_before_time_1", seq: 100, role: "assistant" },
      { id: "msg_after_time_1", seq: 101, role: "user" },
    ]);
  });

  test("resolves bucket profile and prefers preferred-session compact summary", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const readModel = new MeditationReadModel(handle.storage.db);

    expect(readModel.resolveBucketProfile("agent_sub_1", ["sess_pref"])).toEqual({
      agentId: "agent_sub_1",
      kind: "sub",
      displayName: "Atlas Frontend",
      description: "Handles atlas-web frontend tasks.",
      workdir: "/repo/atlas-web",
      compactSummary: "Preferred compact summary",
    });
  });
});
