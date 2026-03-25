import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createReviewPermissionRequestTool } from "@/src/tools/review-permission-request.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("review_permission_request tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  function seedFixture(): void {
    if (handle == null) {
      throw new Error("test database handle is missing");
    }

    handle.storage.sqlite.exec(`
      INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
      VALUES ('ci_1', 'lark', 'acct_a', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

      INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
      VALUES
        ('conv_main', 'ci_1', 'chat_main', 'dm', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
        ('conv_sub', 'ci_1', 'chat_sub', 'group', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

      INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
      VALUES
        ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'),
        ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

      INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
      VALUES
        ('agent_main', 'conv_main', NULL, 'main', '2026-03-25T00:00:00.000Z'),
        ('agent_sub', 'conv_sub', 'agent_main', 'sub', '2026-03-25T00:00:00.000Z');

      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status,
        approval_for_session_id, forked_from_session_id, fork_source_seq, compact_cursor, created_at, updated_at
      ) VALUES
        ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active', NULL, NULL, NULL, 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:01.000Z'),
        ('sess_task', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'paused', NULL, NULL, NULL, 0, '2026-03-25T00:00:01.000Z', '2026-03-25T00:00:02.000Z'),
        ('sess_other', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'paused', NULL, NULL, NULL, 0, '2026-03-25T00:00:02.500Z', '2026-03-25T00:00:02.500Z'),
        ('sess_approval', 'conv_main', 'branch_main', 'agent_main', 'approval', 'isolated', 'active', 'sess_task', 'sess_main', 0, 0, '2026-03-25T00:00:03.000Z', '2026-03-25T00:00:04.000Z');

      INSERT INTO approval_ledger (
        owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
        reason_text, created_at
      ) VALUES (
        'agent_sub',
        'sess_task',
        '{"scopes":[{"kind":"fs.write","path":"/tmp/demo.txt"}]}',
        'main_agent',
        'pending',
        'Need to update the requested task output.',
        '2026-03-25T00:00:02.000Z'
      );
    `);
  }

  test("submits an approval decision through runtime control", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    const registry = new ToolRegistry([createReviewPermissionRequestTool()]);
    const submitApprovalDecision = vi.fn().mockReturnValue(true);

    const result = await registry.execute(
      "review_permission_request",
      {
        sessionId: "sess_approval",
        conversationId: "conv_main",
        ownerAgentId: "agent_main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: { submitApprovalDecision },
      },
      {
        approvalId: 1,
        decision: "approve",
        reason: "Needed for this background task.",
      },
    );

    expect(submitApprovalDecision).toHaveBeenCalledTimes(1);
    expect(submitApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 1,
        decision: "approve",
        grantedBy: "main_agent",
        reasonText: "Needed for this background task.",
        actor: "main_agent:agent_main",
      }),
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Recorded approve for approval 1. Reason: Needed for this background task.",
      },
    ]);
  });

  test("rejects approvals that do not belong to the current approval session source run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture();
    handle.storage.sqlite.exec(`
      INSERT INTO approval_ledger (
        owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
        reason_text, created_at
      ) VALUES (
        'agent_sub',
        'sess_other',
        '{"scopes":[{"kind":"fs.write","path":"/tmp/other.txt"}]}',
        'main_agent',
        'pending',
        'Need to update another task output.',
        '2026-03-25T00:00:05.000Z'
      );
    `);

    const registry = new ToolRegistry([createReviewPermissionRequestTool()]);

    await expect(
      registry.execute(
        "review_permission_request",
        {
          sessionId: "sess_approval",
          conversationId: "conv_main",
          ownerAgentId: "agent_main",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: { submitApprovalDecision: vi.fn() },
        },
        {
          approvalId: 2,
          decision: "deny",
          reason: "Wrong task.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "approval_not_for_current_session",
        approvalId: 2,
      },
    });
  });
});
