import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createGetRuntimeStatusTool } from "@/src/tools/get-runtime-status.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("get_runtime_status tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("returns all active runs for the main agent by default", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture(handle);

    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_1",
      sessionId: "sess_main",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });
    control.markLlmRequestStarted({
      runId: "run_1",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_1",
      kind: "text",
      deltaText: "hello world",
      at: new Date("2026-04-04T00:00:02.000Z"),
    });
    control.markToolStarted({
      runId: "run_1",
      toolCallId: "tool_1",
      toolName: "grep",
    });

    const registry = new ToolRegistry();
    registry.register(createGetRuntimeStatusTool());
    const result = await registry.execute(
      "get_runtime_status",
      {
        sessionId: "sess_main",
        conversationId: "conv_1",
        ownerAgentId: "agent_main",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: () => false,
          getRuntimeStatus: (input) => {
            const now = new Date("2026-04-04T00:00:05.000Z");
            if (input?.runId != null) {
              const run = control.getRunObservability(input.runId, now);
              return run == null
                ? {
                    now: now.toISOString(),
                    found: false as const,
                    runId: input.runId,
                    message: "missing",
                  }
                : {
                    now: now.toISOString(),
                    found: true as const,
                    run,
                  };
            }
            return {
              now: now.toISOString(),
              runs: control.listActiveRunObservability(now),
            };
          },
        },
      },
      {},
    );

    expect(result).toEqual({
      content: [
        {
          type: "json",
          json: {
            now: "2026-04-04T00:00:05.000Z",
            runs: [
              expect.objectContaining({
                runId: "run_1",
                phase: "tool_running",
                timeSinceStartMs: 5000,
                responseSummary: expect.objectContaining({
                  requestCount: 1,
                  respondedRequestCount: 1,
                  hasAnyResponse: true,
                  lastRespondedRequestTtftMs: 2000,
                }),
                latestRequest: expect.objectContaining({
                  status: "finished",
                  outputChars: 11,
                  estimatedOutputTokens: 3,
                  ttftMs: 2000,
                  timeSinceLastTokenMs: 3000,
                }),
                activeToolName: "grep",
              }),
            ],
          },
        },
      ],
    });
  });

  test("returns a finished run by runId even after it leaves the active list", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture(handle);

    const control = new RuntimeControlService(new SessionRunAbortRegistry());
    control.beginRun({
      runId: "run_done",
      sessionId: "sess_main",
      conversationId: "conv_1",
      branchId: "branch_1",
      scenario: "chat",
    });
    control.markLlmRequestStarted({
      runId: "run_done",
      assistantMessageId: "msg_1",
      at: new Date("2026-04-04T00:00:00.000Z"),
    });
    control.recordStreamDelta({
      runId: "run_done",
      kind: "text",
      deltaText: "done",
      at: new Date("2026-04-04T00:00:02.000Z"),
    });
    control.markCompleted({
      runId: "run_done",
      at: new Date("2026-04-04T00:00:03.000Z"),
    });
    control.finishRun("run_done");

    const registry = new ToolRegistry();
    registry.register(createGetRuntimeStatusTool());
    const result = await registry.execute(
      "get_runtime_status",
      {
        sessionId: "sess_main",
        conversationId: "conv_1",
        ownerAgentId: "agent_main",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: () => false,
          getRuntimeStatus: (input) => {
            const now = new Date("2026-04-04T00:00:05.000Z");
            if (input?.runId != null) {
              const run = control.getRunObservability(input.runId, now);
              return run == null
                ? {
                    now: now.toISOString(),
                    found: false as const,
                    runId: input.runId,
                    message: "missing",
                  }
                : {
                    now: now.toISOString(),
                    found: true as const,
                    run,
                  };
            }
            return {
              now: now.toISOString(),
              runs: control.listActiveRunObservability(now),
            };
          },
        },
      },
      { runId: "run_done" },
    );

    expect(result).toEqual({
      content: [
        {
          type: "json",
          json: {
            now: "2026-04-04T00:00:05.000Z",
            found: true,
            run: expect.objectContaining({
              runId: "run_done",
              phase: "completed",
              responseSummary: expect.objectContaining({
                requestCount: 1,
                respondedRequestCount: 1,
                hasAnyResponse: true,
                lastRespondedRequestTtftMs: 2000,
              }),
              latestRequest: expect.objectContaining({
                status: "finished",
                ttftMs: 2000,
              }),
            }),
          },
        },
      ],
    });
  });

  test("returns a clear not-found result when a requested run is absent from live memory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture(handle);

    const registry = new ToolRegistry();
    registry.register(createGetRuntimeStatusTool());
    const result = await registry.execute(
      "get_runtime_status",
      {
        sessionId: "sess_main",
        conversationId: "conv_1",
        ownerAgentId: "agent_main",
        agentKind: "main",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        runtimeControl: {
          submitApprovalDecision: () => false,
          getRuntimeStatus: (input) => ({
            now: "2026-04-04T00:00:05.000Z",
            found: false as const,
            runId: input?.runId ?? "",
            message:
              "Current live runtime status was not found for that run. It may have already completed, failed, been cancelled, or been lost after process restart.",
          }),
        },
      },
      { runId: "run_missing" },
    );

    expect(result).toEqual({
      content: [
        {
          type: "json",
          json: {
            now: "2026-04-04T00:00:05.000Z",
            found: false,
            runId: "run_missing",
            message:
              "Current live runtime status was not found for that run. It may have already completed, failed, been cancelled, or been lost after process restart.",
          },
        },
      ],
    });
  });

  test("rejects calls from non-main agents", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedSubagentFixture(handle);

    const registry = new ToolRegistry();
    registry.register(createGetRuntimeStatusTool());

    await expect(
      registry.execute(
        "get_runtime_status",
        {
          sessionId: "sess_sub",
          conversationId: "conv_1",
          ownerAgentId: "agent_sub",
          agentKind: "sub",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: () => false,
            getRuntimeStatus: () => ({
              now: "2026-04-04T00:00:05.000Z",
              runs: [],
            }),
          },
        },
        {},
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "get_runtime_status is only available to the main agent.",
    } satisfies Partial<ToolFailure>);
  });

  test("fails clearly when runtime control does not expose live status access", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainAgentFixture(handle);

    const registry = new ToolRegistry();
    registry.register(createGetRuntimeStatusTool());

    await expect(
      registry.execute(
        "get_runtime_status",
        {
          sessionId: "sess_main",
          conversationId: "conv_1",
          ownerAgentId: "agent_main",
          agentKind: "main",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          runtimeControl: {
            submitApprovalDecision: () => false,
          },
        },
        {},
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "internal_error",
      message: expect.stringContaining("missing the host runtime control"),
    } satisfies Partial<ToolFailure>);
  });
});

function seedMainAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_main', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_main', 'conv_1', 'main', '2026-04-04T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
    VALUES ('sess_main', 'conv_1', 'branch_1', 'agent_main', 'chat', 'active', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');
  `);
}

function seedSubagentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_sub', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_sub', 'conv_1', 'sub', '2026-04-04T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
    VALUES ('sess_sub', 'conv_1', 'branch_1', 'agent_sub', 'chat', 'active', '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z');
  `);
}
