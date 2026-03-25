import { describe, expect, test, vi } from "vitest";

import { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createMainAgentApprovalSessionId } from "@/src/orchestration/approval-session.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

function seedFixture(handle: TestDatabaseHandle): void {
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

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES
      ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active', 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:01.000Z'),
      ('sess_sub', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'active', 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:01.000Z');

    INSERT INTO approval_ledger (
      owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
      reason_text, created_at
    ) VALUES (
      'agent_sub',
      'sess_sub',
      '{"scopes":[{"kind":"fs.write","path":"/tmp/demo.txt"}]}',
      'main_agent',
      'pending',
      'Need to update the requested task output.',
      '2026-03-25T00:00:02.000Z'
    );
  `);
}

describe("AgentManager", () => {
  test("forwards user messages to runtime ingress", async () => {
    const submitMessage = vi.fn(
      async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
        return { status: "steered" };
      },
    );
    const submitApprovalDecision = vi.fn(() => false);
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision,
      },
    });

    const result = await manager.submitUserMessage({
      sessionId: "sess_1",
      scenario: "chat",
      content: "hello",
    });

    expect(result).toEqual({ status: "steered" });
    expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "sess_1",
      scenario: "chat",
      content: "hello",
    });
    expect(submitApprovalDecision).not.toHaveBeenCalled();
  });

  test("forwards approval decisions to runtime ingress", () => {
    const submitMessage = vi.fn();
    const submitApprovalDecision = vi.fn(() => true);
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision,
      },
    });

    const matched = manager.submitApprovalDecision({
      approvalId: 42,
      decision: "approve",
      actor: "user:demo",
    });

    expect(matched).toBe(true);
    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 42,
      decision: "approve",
      actor: "user:demo",
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test("delivers delegated approval requests for main-agent-targeted runtime events", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitted: SubmitMessageInput[] = [];
      const manager = new AgentManager({
        storage: handle.storage.db,
        ingress: {
          async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
            submitted.push(input);
            return { status: "steered" };
          },
          submitApprovalDecision: vi.fn(() => false),
        },
      });

      const result = await manager.handleRuntimeEvent({
        type: "approval_requested",
        eventId: "evt_1",
        createdAt: "2026-03-25T00:00:03.000Z",
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        branchId: "branch_sub",
        runId: "run_1",
        approvalId: "1",
        approvalTarget: "main_agent",
        title: "Need approval",
        reasonText: "Need to update the requested task output.",
        options: [],
        expiresAt: null,
      });

      expect(result).toEqual({
        status: "delivered",
        approvalId: 1,
        targetSessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_sub",
          approvalId: 1,
        }),
      });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({
        sessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_sub",
          approvalId: 1,
        }),
        scenario: "chat",
        messageType: "approval_request",
        visibility: "hidden_system",
      });
    });
  });

  test("ignores non-delegated approval events", async () => {
    const submitMessage = vi.fn(
      async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
        return { status: "steered" };
      },
    );
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    const result = await manager.handleRuntimeEvent({
      type: "approval_requested",
      eventId: "evt_1",
      createdAt: "2026-03-25T00:00:03.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      approvalId: "1",
      approvalTarget: "user",
      title: "Need approval",
      reasonText: "Need permission.",
      options: [],
      expiresAt: null,
    });

    expect(result).toBeNull();
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test("returns null for invalid delegated approval ids", async () => {
    const submitMessage = vi.fn(
      async (_input: SubmitMessageInput): Promise<SubmitMessageResult> => {
        return { status: "steered" };
      },
    );
    const manager = new AgentManager({
      storage: null as never,
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });

    const result = await manager.handleRuntimeEvent({
      type: "approval_requested",
      eventId: "evt_1",
      createdAt: "2026-03-25T00:00:03.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      approvalId: "not-a-number",
      approvalTarget: "main_agent",
      title: "Need approval",
      reasonText: "Need permission.",
      options: [],
      expiresAt: null,
    });

    expect(result).toBeNull();
    expect(submitMessage).not.toHaveBeenCalled();
  });
});
