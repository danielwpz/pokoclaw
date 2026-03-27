import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createCronTool } from "@/src/tools/cron.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, title, created_at, updated_at)
    VALUES
      ('conv_main', 'ci_1', 'chat_main', 'dm', 'Main Agent', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'),
      ('conv_sub', 'ci_1', 'chat_sub', 'group', 'PR Review', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES
      ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'),
      ('branch_sub', 'conv_sub', 'group_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, display_name, created_at)
    VALUES
      ('agent_main', 'conv_main', NULL, 'main', 'Main Agent', '2026-03-27T00:00:00.000Z'),
      ('agent_sub', 'conv_sub', 'agent_main', 'sub', 'PR Review', '2026-03-27T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at)
    VALUES
      ('sess_main', 'conv_main', 'branch_main', 'agent_main', 'chat', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'),
      ('sess_sub', 'conv_sub', 'branch_sub', 'agent_sub', 'chat', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      name, schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
    ) VALUES
      (
        'cron_main', 'agent_main', 'conv_main', 'branch_main',
        'Main digest', 'every', '60000', '{"prompt":"digest"}', '2026-03-27T13:00:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      ),
      (
        'cron_sub', 'agent_sub', 'conv_sub', 'branch_sub',
        'PR review', 'cron', '0 8 * * *', '{"prompt":"review prs"}', '2026-03-28T00:00:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
  `);
}

describe("cron tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("subagent creates cron jobs owned by itself and bound to its main branch", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const registry = new ToolRegistry([createCronTool()]);
    const result = await registry.execute(
      "cron",
      {
        sessionId: "sess_sub",
        conversationId: "conv_sub",
        ownerAgentId: "agent_sub",
        agentKind: "sub",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
          runCronJobNow: vi.fn(),
        },
      },
      {
        action: "add",
        name: "Morning review",
        scheduleKind: "every",
        scheduleValue: "60000",
        prompt: "Review open pull requests.",
      },
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Created cron job"),
    });

    const rows = handle.storage.sqlite
      .prepare(
        "SELECT owner_agent_id, target_conversation_id, target_branch_id, payload_json FROM cron_jobs WHERE name = ?",
      )
      .all("Morning review") as Array<{
      owner_agent_id: string;
      target_conversation_id: string;
      target_branch_id: string;
      payload_json: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      owner_agent_id: "agent_sub",
      target_conversation_id: "conv_sub",
      target_branch_id: "branch_sub",
      payload_json: "Review open pull requests.",
    });
  });

  test("main agent listing includes subagent-owned cron jobs in its management scope", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const registry = new ToolRegistry([createCronTool()]);
    const result = await registry.execute(
      "cron",
      {
        sessionId: "sess_main",
        conversationId: "conv_main",
        ownerAgentId: "agent_main",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
          runCronJobNow: vi.fn(),
        },
      },
      {
        action: "list",
        includeDisabled: true,
      },
    );

    expect(result.content[0]).toEqual({
      type: "json",
      json: {
        jobs: expect.arrayContaining([
          expect.objectContaining({ id: "cron_main", ownerAgentId: "agent_main" }),
          expect.objectContaining({ id: "cron_sub", ownerAgentId: "agent_sub" }),
        ]),
      },
    });
  });

  test("main agent can manually run a subagent-owned cron job", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const runCronJobNow = vi.fn(async () => ({
      accepted: true,
      cronJobId: "cron_sub",
    }));
    const registry = new ToolRegistry([createCronTool()]);

    const result = await registry.execute(
      "cron",
      {
        sessionId: "sess_main",
        conversationId: "conv_main",
        ownerAgentId: "agent_main",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: vi.fn(),
          runCronJobNow,
        },
      },
      {
        action: "run",
        jobId: "cron_sub",
      },
    );

    expect(runCronJobNow).toHaveBeenCalledExactlyOnceWith({
      jobId: "cron_sub",
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining('Triggered cron job "PR review"'),
    });
  });

  test("main agent cannot update a subagent-owned cron definition", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const registry = new ToolRegistry([createCronTool()]);

    await expect(
      registry.execute(
        "cron",
        {
          sessionId: "sess_main",
          conversationId: "conv_main",
          ownerAgentId: "agent_main",
          agentKind: "main",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: vi.fn(),
            runCronJobNow: vi.fn(),
          },
        },
        {
          action: "update",
          jobId: "cron_sub",
          prompt: "Changed by main agent.",
        },
      ),
    ).rejects.toThrow("You can only change cron jobs owned by this agent.");
  });

  test("main agent can pause and resume a subagent-owned cron job", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const registry = new ToolRegistry([createCronTool()]);
    const context = {
      sessionId: "sess_main",
      conversationId: "conv_main",
      ownerAgentId: "agent_main",
      agentKind: "main" as const,
      securityConfig: DEFAULT_CONFIG.security,
      storage: handle.storage.db,
      runtimeControl: {
        submitApprovalDecision: vi.fn(),
        runCronJobNow: vi.fn(),
      },
    };

    await registry.execute("cron", context, {
      action: "pause",
      jobId: "cron_sub",
    });

    const paused = handle.storage.sqlite
      .prepare("SELECT enabled, next_run_at FROM cron_jobs WHERE id = ?")
      .get("cron_sub") as { enabled: number; next_run_at: string | null };
    expect(paused).toEqual({
      enabled: 0,
      next_run_at: null,
    });

    await registry.execute("cron", context, {
      action: "resume",
      jobId: "cron_sub",
    });

    const resumed = handle.storage.sqlite
      .prepare("SELECT enabled, next_run_at FROM cron_jobs WHERE id = ?")
      .get("cron_sub") as { enabled: number; next_run_at: string | null };
    expect(resumed.enabled).toBe(1);
    expect(resumed.next_run_at).not.toBeNull();
  });
});
