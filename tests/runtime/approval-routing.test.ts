import { describe, expect, test } from "vitest";

import { resolveApprovalRouteForSession } from "@/src/runtime/approval-routing.js";
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

function seedBase(handle: TestDatabaseHandle) {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES
      ('conv_1-sub', 'ci_1', 'chat_sub', 'group', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_sub', 'conv_1-sub', 'group_main', 'main', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES
      ('agent_main', 'conv_1', 'main', '2026-03-25T00:00:00.000Z'),
      ('agent_sub', 'conv_1-sub', 'sub', '2026-03-25T00:00:00.000Z');
  `);
}

describe("approval routing", () => {
  test("routes main-agent chat sessions to user approvals", async () => {
    await withHandle(async (handle) => {
      seedBase(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_main",
        conversationId: "conv_1",
        branchId: "branch_1",
        ownerAgentId: "agent_main",
        purpose: "chat",
      });

      const session = sessionsRepo.getById("sess_main");
      expect(session).not.toBeNull();
      if (session == null) {
        throw new Error("Expected sess_main to exist");
      }

      const route = resolveApprovalRouteForSession({
        db: handle.storage.db,
        session,
      });

      expect(route).toEqual({
        target: "user",
        runtimeKind: "main_chat",
        ownerRole: "main",
        taskRunId: null,
      });
    });
  });

  test("routes subagent chat sessions to user approvals", async () => {
    await withHandle(async (handle) => {
      seedBase(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_sub",
        conversationId: "conv_1-sub",
        branchId: "branch_sub",
        ownerAgentId: "agent_sub",
        purpose: "chat",
      });
      const session = sessionsRepo.getById("sess_sub");
      expect(session).not.toBeNull();
      if (session == null) {
        throw new Error("Expected sess_sub to exist");
      }

      const route = resolveApprovalRouteForSession({
        db: handle.storage.db,
        session,
      });

      expect(route).toEqual({
        target: "user",
        runtimeKind: "subagent_chat",
        ownerRole: "subagent",
        taskRunId: null,
      });
    });
  });

  test("routes task-purpose sessions to main-agent approvals", async () => {
    await withHandle(async (handle) => {
      seedBase(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_task",
        conversationId: "conv_1-sub",
        branchId: "branch_sub",
        ownerAgentId: "agent_sub",
        purpose: "task",
      });
      const session = sessionsRepo.getById("sess_task");
      expect(session).not.toBeNull();
      if (session == null) {
        throw new Error("Expected sess_task to exist");
      }

      const route = resolveApprovalRouteForSession({
        db: handle.storage.db,
        session,
      });

      expect(route).toEqual({
        target: "main_agent",
        runtimeKind: "task_session",
        ownerRole: "subagent",
        taskRunId: null,
      });
    });
  });

  test("routes delegate task runs to main-agent approvals", async () => {
    await withHandle(async (handle) => {
      seedBase(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_delegate",
        conversationId: "conv_1-sub",
        branchId: "branch_sub",
        ownerAgentId: "agent_sub",
        purpose: "task",
      });
      handle.storage.sqlite.exec(`
        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id,
          execution_session_id, status, started_at
        ) VALUES (
          'run_delegate', 'delegate', 'agent_sub', 'conv_1-sub', 'branch_sub',
          'sess_delegate', 'running', '2026-03-25T00:00:00.000Z'
        );
      `);
      const session = sessionsRepo.getById("sess_delegate");
      expect(session).not.toBeNull();
      if (session == null) {
        throw new Error("Expected sess_delegate to exist");
      }

      const route = resolveApprovalRouteForSession({
        db: handle.storage.db,
        session,
      });

      expect(route).toEqual({
        target: "main_agent",
        runtimeKind: "delegate_run",
        ownerRole: "subagent",
        taskRunId: "run_delegate",
      });
    });
  });

  test("routes cron task runs to main-agent approvals", async () => {
    await withHandle(async (handle) => {
      seedBase(handle);
      const sessionsRepo = new SessionsRepo(handle.storage.db);
      sessionsRepo.create({
        id: "sess_cron",
        conversationId: "conv_1",
        branchId: "branch_1",
        ownerAgentId: "agent_main",
        purpose: "task",
      });
      handle.storage.sqlite.exec(`
        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id,
          schedule_kind, schedule_value, payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_1', 'branch_1',
          'cron', '0 * * * *', '{}', '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id,
          cron_job_id, execution_session_id, status, started_at
        ) VALUES (
          'run_cron', 'cron', 'agent_main', 'conv_1', 'branch_1',
          'cron_1', 'sess_cron', 'running', '2026-03-25T00:00:00.000Z'
        );
      `);
      const session = sessionsRepo.getById("sess_cron");
      expect(session).not.toBeNull();
      if (session == null) {
        throw new Error("Expected sess_cron to exist");
      }

      const route = resolveApprovalRouteForSession({
        db: handle.storage.db,
        session,
      });

      expect(route).toEqual({
        target: "main_agent",
        runtimeKind: "cron_run",
        ownerRole: "main",
        taskRunId: "run_cron",
      });
    });
  });
});
