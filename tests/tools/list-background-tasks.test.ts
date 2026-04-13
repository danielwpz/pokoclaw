import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createListBackgroundTasksTool } from "@/src/tools/list-background-tasks.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("list_background_tasks tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  function seedFixture() {
    if (handle == null) {
      throw new Error("test database handle is missing");
    }

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES
        ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z'),
        ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES
        ('branch_main', 'conv_main', 'dm_main', 'main', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z'),
        ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES
        ('agent_main', 'conv_main', NULL, 'main', '2026-04-03T00:00:00.000Z'),
        ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-04-03T00:00:00.000Z');

      INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
      VALUES
        ('sess_sub', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z'),
        ('sess_sub_2', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', '2026-04-03T00:00:00.000Z', '2026-04-03T00:00:00.000Z');

      INSERT INTO task_runs (
        id, run_type, owner_agent_id, conversation_id, branch_id,
        initiator_session_id, status, description, input_json, result_summary, started_at, finished_at
      ) VALUES
      (
        'task_bg_running', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        'sess_sub', 'running', 'Running background scan',
        '{"kind":"background_task","version":1,"taskDefinition":"Scan repository and report risks."}',
        NULL, '2026-04-03T00:10:00.000Z', NULL
      ),
      (
        'task_bg_completed', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        'sess_sub', 'completed', 'Done background scan',
        '{"kind":"background_task","version":1,"taskDefinition":"Build nightly report."}',
        'Nightly report generated.', '2026-04-03T00:05:00.000Z', '2026-04-03T00:08:00.000Z'
      ),
      (
        'task_not_background', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        'sess_sub', 'running', 'Legacy delegate',
        '{"taskDefinition":"legacy payload without marker"}',
        NULL, '2026-04-03T00:12:00.000Z', NULL
      ),
      (
        'task_other_session', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub',
        'sess_sub_2', 'running', 'Other chat session task',
        '{"kind":"background_task","version":1,"taskDefinition":"Other session work."}',
        NULL, '2026-04-03T00:15:00.000Z', NULL
      );
    `);
  }

  test("lists running background tasks for the current chat session by default", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createListBackgroundTasksTool()]);

    const result = await registry.execute(
      "list_background_tasks",
      {
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        ownerAgentId: "agent_sub",
        agentKind: "sub",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
        },
      },
      {},
    );

    expect(result.content[0]).toEqual({
      type: "json",
      json: {
        statusFilter: "running",
        tasks: [
          expect.objectContaining({
            taskRunId: "task_bg_running",
            status: "running",
            description: "Running background scan",
          }),
        ],
      },
    });
  });

  test('can include settled tasks when status="all"', async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createListBackgroundTasksTool()]);

    const result = await registry.execute(
      "list_background_tasks",
      {
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        ownerAgentId: "agent_sub",
        agentKind: "sub",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
        },
      },
      {
        status: "all",
        limit: 10,
      },
    );

    expect(result.content[0]).toEqual({
      type: "json",
      json: {
        statusFilter: "all",
        tasks: [
          expect.objectContaining({
            taskRunId: "task_bg_running",
            status: "running",
          }),
          expect.objectContaining({
            taskRunId: "task_bg_completed",
            status: "completed",
            resultSummary: "Nightly report generated.",
          }),
        ],
      },
    });
  });
});
