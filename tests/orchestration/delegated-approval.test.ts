import { describe, expect, test } from "vitest";
import { createMainAgentApprovalSessionId } from "@/src/orchestration/approval-session.js";
import {
  deliverDelegatedApprovalRequest,
  renderDelegatedApprovalMessage,
} from "@/src/orchestration/delegated-approval.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
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

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, description, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', 'Primary DM assistant.', '2026-03-25T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', 'Handles delegated file update tasks.', '2026-03-25T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, context_mode, status, compact_cursor, created_at, updated_at)
    VALUES
      ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', 'isolated', 'active', 0, '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:01.000Z'),
      ('sess_task', 'conv_sub', 'branch_sub', 'agent_sub', 'task', 'isolated', 'active', 0, '2026-03-25T00:00:01.000Z', '2026-03-25T00:00:02.000Z');

    INSERT INTO task_runs (
      id, run_type, owner_agent_id, conversation_id, branch_id, execution_session_id,
      status, description, input_json, started_at
    ) VALUES (
      'run_1', 'delegate', 'agent_sub', 'conv_sub', 'branch_sub', 'sess_task',
      'running', 'Update the task output file requested by the user.',
      '{"goal":"update demo output","targetPath":"/tmp/demo.txt"}',
      '2026-03-25T00:00:01.000Z'
    );

    INSERT INTO messages (id, session_id, seq, role, payload_json, created_at)
    VALUES
      ('msg_task_user', 'sess_task', 1, 'user', '{"content":"Update /tmp/demo.txt for the delegated task."}', '2026-03-25T00:00:01.100Z'),
      ('msg_task_assistant', 'sess_task', 2, 'assistant', '{"content":[{"type":"toolCall","id":"tool_1","name":"write","arguments":{"path":"/tmp/demo.txt"}}]}', '2026-03-25T00:00:01.200Z'),
      ('msg_task_tool', 'sess_task', 3, 'tool', '{"toolCallId":"tool_1","toolName":"write","content":[{"type":"text","text":"Write access is missing for /tmp/demo.txt"}],"isError":true,"details":{"code":"permission_denied","summary":"Write access is missing for /tmp/demo.txt"}}', '2026-03-25T00:00:01.300Z');

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
      context: {
        sessionPurpose: "task",
        agentKind: "sub",
        agentDescription: "Handles delegated file update tasks.",
        taskRunId: "run_1",
        runType: "delegate",
        taskDescription: "Update the task output file requested by the user.",
        taskInputSummary: '{"goal":"update demo output"}',
        recentTranscript: [
          { seq: 1, role: "user", summary: "Update /tmp/demo.txt for the delegated task." },
          {
            seq: 2,
            role: "tool",
            summary: "blocked by permissions: Write access is missing for /tmp/demo.txt",
          },
        ],
      },
    });

    expect(text).toContain("<delegated_approval_request>");
    expect(text).toContain("<approval_id>12</approval_id>");
    expect(text).toContain("Need to update the requested task output.");
    expect(text).toContain("Write /tmp/demo.txt");
    expect(text).toContain("<task_context>");
    expect(text).toContain("Handles delegated file update tasks.");
    expect(text).toContain("Update the task output file requested by the user.");
    expect(text).toContain("<recent_task_transcript>");
    expect(text).toContain("blocked by permissions: Write access is missing for /tmp/demo.txt");
  });

  test("renders delegated bash approvals with both prefix and full command text", () => {
    const text = renderDelegatedApprovalMessage({
      approvalId: 13,
      ownerAgentId: "agent_sub",
      reasonText: "Need to inspect the repo and run the requested script.",
      requestedScopeJson: '{"scopes":[{"kind":"bash.full_access","prefix":["bash","-lc"]}]}',
      commandText: "cat foo && npm run foo",
      commandCwd: "/tmp/demo",
    });

    expect(text).toContain("Run bash commands with full access for prefix: bash -lc");
    expect(text).toContain("<requested_command>");
    expect(text).toContain("cat foo &amp;&amp; npm run foo");
    expect(text).toContain("<command_cwd>/tmp/demo</command_cwd>");
  });

  test("delivers a main-agent-targeted approval request into a dedicated approval session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite
        .prepare(
          "UPDATE approval_ledger SET requested_scope_json = ?, resume_payload_json = ? WHERE id = 1",
        )
        .run(
          '{"scopes":[{"kind":"bash.full_access","prefix":["bash","-lc"]}]}',
          '{"toolCallId":"tool_1","toolName":"bash","toolArgs":{"command":"cat foo && npm run foo","cwd":"/tmp/demo"}}',
        );

      const submitted: SubmitMessageInput[] = [];
      const approvalsRepo = new ApprovalsRepo(handle.storage.db);
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          approvalsRepo.resolve({
            id: 1,
            status: "approved",
            reasonText: "Approved during test delivery.",
            decidedAt: new Date("2026-03-25T00:00:02.500Z"),
          });
          return { status: "steered" };
        },
        submitApprovalDecision() {
          return true;
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
      expect(submitted[0]?.afterToolResultHook).toBeDefined();
      expect(
        submitted[0]?.afterToolResultHook?.afterToolResult({
          run: {
            sessionId: submitted[0]?.sessionId ?? "",
            scenario: "chat",
            content: submitted[0]?.content ?? "",
          },
          sessionPurpose: "approval",
          ownerAgentId: "agent_main",
          agentKind: "main",
          runId: "run_approval",
          turn: 1,
          toolCall: {
            id: "call_1",
            name: "review_permission_request",
            args: {
              approvalId: 1,
              decision: "approve",
              reason: "Approved during test delivery.",
            },
          },
          result: {
            content: [
              {
                type: "text",
                text: "Recorded approve for approval 1. Reason: Approved during test delivery.",
              },
            ],
            isError: false,
          },
        } as never),
      ).toEqual({
        kind: "stop_run",
        reason: "approval_review_recorded",
      });
      expect(
        submitted[0]?.afterToolResultHook?.afterToolResult({
          run: {
            sessionId: submitted[0]?.sessionId ?? "",
            scenario: "chat",
            content: submitted[0]?.content ?? "",
          },
          sessionPurpose: "approval",
          ownerAgentId: "agent_main",
          agentKind: "main",
          runId: "run_approval",
          turn: 1,
          toolCall: {
            id: "call_2",
            name: "read",
            args: {
              path: "/tmp/demo.txt",
            },
          },
          result: {
            content: [{ type: "text", text: "demo" }],
            isError: false,
          },
        } as never),
      ).toEqual({ kind: "continue" });
      expect(submitted[0]?.content).toContain("<delegated_approval_request>");
      expect(submitted[0]?.content).toContain("<task_context>");
      expect(submitted[0]?.content).toContain("Handles delegated file update tasks.");
      expect(submitted[0]?.content).toContain("Update the task output file requested by the user.");
      expect(submitted[0]?.content).toContain(
        "Run bash commands with full access for prefix: bash -lc",
      );
      expect(submitted[0]?.content).toContain("<requested_command>");
      expect(submitted[0]?.content).toContain("cat foo &amp;&amp; npm run foo");
      expect(submitted[0]?.content).toContain("<command_cwd>/tmp/demo</command_cwd>");
      expect(submitted[0]?.content).toContain("<recent_task_transcript>");
      expect(submitted[0]?.content).toContain(
        "blocked by permissions: Write access is missing for /tmp/demo.txt",
      );

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
      const approvalsRepo = new ApprovalsRepo(handle.storage.db);
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          const approvalIdMatch = input.content.match(/<approval_id>(\d+)<\/approval_id>/u);
          const approvalId =
            approvalIdMatch?.[1] == null ? null : Number.parseInt(approvalIdMatch[1], 10);
          if (approvalId != null && Number.isFinite(approvalId)) {
            approvalsRepo.resolve({
              id: approvalId,
              status: "approved",
              reasonText: "Approved during test delivery.",
              decidedAt: new Date("2026-03-25T00:00:03.500Z"),
            });
          }
          return { status: "steered" };
        },
        submitApprovalDecision() {
          return true;
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
      const approvalsRepo = new ApprovalsRepo(handle.storage.db);
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          approvalsRepo.resolve({
            id: 1,
            status: "approved",
            reasonText: "Approved during test delivery.",
            decidedAt: new Date("2026-03-25T00:00:02.500Z"),
          });
          return { status: "steered" };
        },
        submitApprovalDecision() {
          return true;
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

  test("renders every requested permission in approval history entries", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO approval_ledger (
          owner_agent_id, requested_by_session_id, requested_scope_json, approval_target, status,
          reason_text, created_at, decided_at
        ) VALUES (
          'agent_sub',
          'sess_task',
          '{"scopes":[{"kind":"fs.read","path":"/tmp/archive.csv"},{"kind":"fs.write","path":"/tmp/report.txt"}]}',
          'main_agent',
          'approved',
          'Approved because both files are part of the daily finance task.',
          '2026-03-24T00:00:00.000Z',
          '2026-03-24T00:01:00.000Z'
        );
      `);

      const submitted: SubmitMessageInput[] = [];
      const approvalsRepo = new ApprovalsRepo(handle.storage.db);
      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          approvalsRepo.resolve({
            id: 1,
            status: "approved",
            reasonText: "Approved during test delivery.",
            decidedAt: new Date("2026-03-25T00:00:02.500Z"),
          });
          return { status: "steered" };
        },
        submitApprovalDecision() {
          return true;
        },
      } as const;

      await deliverDelegatedApprovalRequest({
        db: handle.storage.db,
        ingress,
        approvalId: 1,
      });

      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.content).toContain(
        "<permissions>Read /tmp/archive.csv; Write /tmp/report.txt</permissions>",
      );
      expect(submitted[0]?.content).not.toContain("2 permissions");
    });
  });

  test("auto-denies when the approval session finishes without an explicit decision", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitted: SubmitMessageInput[] = [];
      const decisions: Array<{ approvalId: number; decision: string; reasonText: string | null }> =
        [];
      const approvalsRepo = new ApprovalsRepo(handle.storage.db);

      const ingress = {
        async submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
          submitted.push(input);
          return { status: "steered" };
        },
        submitApprovalDecision(input: {
          approvalId: number;
          decision: "approve" | "deny";
          reasonText?: string | null;
        }) {
          decisions.push({
            approvalId: input.approvalId,
            decision: input.decision,
            reasonText: input.reasonText ?? null,
          });
          approvalsRepo.resolve({
            id: input.approvalId,
            status: "denied",
            reasonText: input.reasonText ?? null,
            decidedAt: new Date("2026-03-25T00:00:02.800Z"),
          });
          return true;
        },
      } as const;

      await deliverDelegatedApprovalRequest({
        db: handle.storage.db,
        ingress,
        approvalId: 1,
      });

      expect(submitted).toHaveLength(2);
      expect(submitted[0]?.messageType).toBe("approval_request");
      expect(submitted[1]?.messageType).toBe("approval_followup");
      expect(submitted[1]?.content).toContain("<approval_decision_required>");
      expect(decisions).toEqual([
        {
          approvalId: 1,
          decision: "deny",
          reasonText: "Approval review session ended without an explicit decision.",
        },
      ]);
    });
  });
});
