import { describe, expect, test } from "vitest";
import { createMainAgentApprovalSessionId } from "@/src/orchestration/approval-session.js";
import {
  deliverDelegatedApprovalRequest,
  renderDelegatedApprovalMessage,
} from "@/src/orchestration/delegated-approval.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
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
      ('sess_task', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'active', 0, '2026-03-25T00:00:01.000Z', '2026-03-25T00:00:02.000Z');

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

describe("delegated approval orchestration", () => {
  test("renders a delegated approval message block", () => {
    const text = renderDelegatedApprovalMessage({
      approvalId: 12,
      ownerAgentId: "agent_sub",
      reasonText: "Need to update the requested task output.",
      requestedScopeJson: '{"scopes":[{"kind":"fs.write","path":"/tmp/demo.txt"}]}',
    });

    expect(text).toContain("<delegated_approval_request>");
    expect(text).toContain("<approval_id>12</approval_id>");
    expect(text).toContain("Need to update the requested task output.");
    expect(text).toContain("Write /tmp/demo.txt");
  });

  test("delivers a main-agent-targeted approval request into a dedicated approval session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitted: SubmitMessageInput[] = [];
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          return { status: "steered" };
        },
      } as const;

      const result = await deliverDelegatedApprovalRequest({
        db: handle.storage.db,
        ingress,
        approvalId: 1,
      });

      expect(result).toEqual({
        status: "delivered",
        approvalId: 1,
        targetSessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_task",
          approvalId: 1,
        }),
      });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({
        sessionId: createMainAgentApprovalSessionId({
          sourceSessionId: "sess_task",
          approvalId: 1,
        }),
        scenario: "chat",
        messageType: "approval_request",
        visibility: "hidden_system",
      });
      expect(submitted[0]?.content).toContain("<delegated_approval_request>");

      const sessionsRepo = new SessionsRepo(handle.storage.db);
      const approvalSession = sessionsRepo.getById(
        createMainAgentApprovalSessionId({
          sourceSessionId: "sess_task",
          approvalId: 1,
        }),
      );
      expect(approvalSession?.purpose).toBe("approval");
      expect(approvalSession?.approvalForSessionId).toBe("sess_task");
      expect(approvalSession?.forkedFromSessionId).toBe("sess_main");
    });
  });

  test("reuses the same approval session for subsequent requests from the same source run", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO approval_ledger (
          owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
          reason_text, created_at
        ) VALUES (
          'agent_sub',
          'sess_task',
          '{"scopes":[{"kind":"fs.read","path":"/tmp/other.txt"}]}',
          'main_agent',
          'pending',
          'Need to inspect another file.',
          '2026-03-25T00:00:03.000Z'
        );
      `);

      const submitted: SubmitMessageInput[] = [];
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          return { status: "steered" };
        },
      } as const;

      const first = await deliverDelegatedApprovalRequest({
        db: handle.storage.db,
        ingress,
        approvalId: 1,
      });
      const second = await deliverDelegatedApprovalRequest({
        db: handle.storage.db,
        ingress,
        approvalId: 2,
      });

      const approvalSessionId = createMainAgentApprovalSessionId({
        sourceSessionId: "sess_task",
        approvalId: 1,
      });
      expect(first).toEqual({
        status: "delivered",
        approvalId: 1,
        targetSessionId: approvalSessionId,
      });
      expect(second).toEqual({
        status: "delivered_reused_session",
        approvalId: 2,
        targetSessionId: approvalSessionId,
      });
      expect(submitted).toHaveLength(2);
      expect(submitted[0]?.sessionId).toBe(approvalSessionId);
      expect(submitted[1]?.sessionId).toBe(approvalSessionId);
    });
  });

  test("includes recent approval history for the same source run", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO approval_ledger (
          owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
          reason_text, created_at, decided_at
        ) VALUES (
          'agent_sub',
          'sess_task',
          '{"scopes":[{"kind":"fs.read","path":"/tmp/archive.csv"}]}',
          'main_agent',
          'approved',
          'Approved because the file is part of the daily finance task.',
          '2026-03-24T00:00:00.000Z',
          '2026-03-24T00:01:00.000Z'
        );
      `);

      const submitted: SubmitMessageInput[] = [];
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          return { status: "steered" };
        },
      } as const;

      await deliverDelegatedApprovalRequest({
        db: handle.storage.db,
        ingress,
        approvalId: 1,
      });

      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.content).toContain("<approval_history>");
      expect(submitted[0]?.content).toContain(
        "Approved because the file is part of the daily finance task.",
      );
      expect(submitted[0]?.content).toContain("Read /tmp/archive.csv");
    });
  });
});
