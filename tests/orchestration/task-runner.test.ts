import { afterEach, describe, expect, test, vi } from "vitest";
import { createTaskExecution } from "@/src/orchestration/task-run-factory.js";
import {
  cancelTaskExecution,
  completeTaskExecution,
  failTaskExecution,
} from "@/src/orchestration/task-run-lifecycle.js";
import { TaskExecutionRunner } from "@/src/tasks/runner.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', NULL, 'main', '2026-03-27T00:00:00.000Z');

    INSERT INTO cron_jobs (
      id, owner_agent_id, target_conversation_id, target_branch_id,
      schedule_kind, schedule_value, payload_json, created_at, updated_at
    ) VALUES (
      'cron_1', 'agent_1', 'conv_1', 'branch_1',
      'cron', '0 * * * *', '{}', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
    );
  `);
}

function requireHandle(handle: TestDatabaseHandle | null): TestDatabaseHandle {
  if (handle == null) {
    throw new Error("Test database handle was not initialized.");
  }

  return handle;
}

describe("TaskExecutionRunner", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("runs a created task execution through runtime ingress and completes it", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const db = requireHandle(handle).storage.db;

    const created = createTaskExecution({
      db,
      params: {
        runType: "delegate",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        description: "Review the requested code changes.",
        inputJson: '{"files":["src/main.ts"]}',
        createdAt: new Date("2026-03-27T00:00:01.000Z"),
      },
    });

    const runner = new TaskExecutionRunner({
      ingress: {
        submitMessage: vi.fn(async (input) => {
          expect(input).toMatchObject({
            sessionId: created.executionSession.id,
            scenario: "subagent",
            messageType: "task_kickoff",
            visibility: "hidden_system",
          });
          expect(input.content).toContain("<task_execution>");
          return {
            status: "started" as const,
            messageId: "msg_1",
            run: {
              runId: "run_loop_1",
              sessionId: created.executionSession.id,
              scenario: "subagent" as const,
              modelId: "test-model",
              appendedMessageIds: [],
              toolExecutions: 0,
              compaction: {
                shouldCompact: false,
                reason: null,
                thresholdTokens: 1000,
                effectiveWindow: 2000,
              },
              events: [],
            },
          };
        }),
      },
      lifecycle: {
        completeTaskExecution: (input) =>
          completeTaskExecution({
            db,
            ...input,
          }),
        failTaskExecution: (input) =>
          failTaskExecution({
            db,
            ...input,
          }),
        cancelTaskExecution: (input) =>
          cancelTaskExecution({
            db,
            ...input,
          }),
      },
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result.status).toBe("completed");
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "completed",
    });
    expect(result.settled.executionSession).toMatchObject({
      id: created.executionSession.id,
      status: "completed",
    });
  });

  test("marks the task run failed when runtime ingress rejects the kickoff run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const db = requireHandle(handle).storage.db;

    const created = createTaskExecution({
      db,
      params: {
        runType: "system",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
      },
    });

    const runner = new TaskExecutionRunner({
      ingress: {
        submitMessage: vi.fn(async () => {
          throw new Error("upstream timeout");
        }),
      },
      lifecycle: {
        completeTaskExecution: (input) =>
          completeTaskExecution({
            db,
            ...input,
          }),
        failTaskExecution: (input) =>
          failTaskExecution({
            db,
            ...input,
          }),
        cancelTaskExecution: (input) =>
          cancelTaskExecution({
            db,
            ...input,
          }),
      },
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result).toMatchObject({
      status: "failed",
      errorMessage: "upstream timeout",
    });
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "failed",
      errorText: "upstream timeout",
    });
  });

  test("marks the task run cancelled for abort-like runtime errors", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const db = requireHandle(handle).storage.db;

    const created = createTaskExecution({
      db,
      params: {
        runType: "cron",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        cronJobId: "cron_1",
      },
    });

    const runner = new TaskExecutionRunner({
      ingress: {
        submitMessage: vi.fn(async () => {
          throw new Error("stop requested");
        }),
      },
      lifecycle: {
        completeTaskExecution: (input) =>
          completeTaskExecution({
            db,
            ...input,
          }),
        failTaskExecution: (input) =>
          failTaskExecution({
            db,
            ...input,
          }),
        cancelTaskExecution: (input) =>
          cancelTaskExecution({
            db,
            ...input,
          }),
      },
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result).toMatchObject({
      status: "cancelled",
      errorMessage: "stop requested",
    });
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "cancelled",
      cancelledBy: "system:task_runner",
    });
  });

  test("includes recent cron run summaries in cron kickoff messages", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const db = requireHandle(handle).storage.db;

    const created = createTaskExecution({
      db,
      params: {
        runType: "cron",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        cronJobId: "cron_1",
        inputJson: JSON.stringify({
          taskDefinition:
            "看到这条消息意味着现在要执行日报任务。请汇总昨天完成的事项并生成一条可直接发送给用户的日报。",
          recentRuns: {
            lastRun: {
              startedAt: "2026-03-27T08:00:00.000Z",
              status: "failed",
              error: "Slack API timeout",
            },
            lastSuccessfulRun: {
              startedAt: "2026-03-26T08:00:00.000Z",
              status: "completed",
              summary: "Posted the daily report with 5 items.",
            },
          },
        }),
      },
    });

    const runner = new TaskExecutionRunner({
      ingress: {
        submitMessage: vi.fn(async (input) => {
          expect(input).toMatchObject({
            sessionId: created.executionSession.id,
            scenario: "cron",
            messageType: "cron_kickoff",
            visibility: "hidden_system",
          });
          expect(input.content).toContain("<task_definition>");
          expect(input.content).toContain("看到这条消息意味着现在要执行日报任务");
          expect(input.content).toContain("<recent_runs>");
          expect(input.content).toContain("<last_run>");
          expect(input.content).toContain("Slack API timeout");
          expect(input.content).toContain("<last_successful_run>");
          expect(input.content).toContain("Posted the daily report with 5 items.");
          expect(input.content).toContain("You are running in background mode");
          expect(input.content).toContain("The final response is the primary user-facing output");
          return {
            status: "started" as const,
            messageId: "msg_1",
            run: {
              runId: "run_loop_1",
              sessionId: created.executionSession.id,
              scenario: "cron" as const,
              modelId: "test-model",
              appendedMessageIds: [],
              toolExecutions: 0,
              compaction: {
                shouldCompact: false,
                reason: null,
                thresholdTokens: 1000,
                effectiveWindow: 2000,
              },
              events: [],
            },
          };
        }),
      },
      lifecycle: {
        completeTaskExecution: (input) =>
          completeTaskExecution({
            db,
            ...input,
          }),
        failTaskExecution: (input) =>
          failTaskExecution({
            db,
            ...input,
          }),
        cancelTaskExecution: (input) =>
          cancelTaskExecution({
            db,
            ...input,
          }),
      },
    });

    const result = await runner.runCreatedTaskExecution({ created });
    expect(result.status).toBe("completed");
  });

  test("fails the task execution when its execution session is unexpectedly already active", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const db = requireHandle(handle).storage.db;

    const created = createTaskExecution({
      db,
      params: {
        runType: "delegate",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
      },
    });

    const runner = new TaskExecutionRunner({
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "steered" as const })),
      },
      lifecycle: {
        completeTaskExecution: (input) =>
          completeTaskExecution({
            db,
            ...input,
          }),
        failTaskExecution: (input) =>
          failTaskExecution({
            db,
            ...input,
          }),
        cancelTaskExecution: (input) =>
          cancelTaskExecution({
            db,
            ...input,
          }),
      },
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result.status).toBe("failed");
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "failed",
    });
  });
});
