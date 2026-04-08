import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop, type AgentModelRunner } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { createTaskExecution } from "@/src/orchestration/task-run-factory.js";
import {
  blockTaskExecution,
  cancelTaskExecution,
  completeTaskExecution,
  failTaskExecution,
} from "@/src/orchestration/task-run-lifecycle.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskExecutionRunner } from "@/src/tasks/runner.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createFinishTaskTool } from "@/src/tools/finish-task.js";
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

function makeStartedRun(input: {
  sessionId: string;
  scenario: "subagent" | "cron";
  stopSignal?: { reason: string; payload?: unknown } | null;
}) {
  return {
    status: "started" as const,
    messageId: "msg_1",
    run: {
      runId: "run_loop_1",
      sessionId: input.sessionId,
      scenario: input.scenario,
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
      stopSignal: input.stopSignal ?? null,
    },
  };
}

function createModelConfig(): Pick<AppConfig, "providers" | "models"> {
  return {
    providers: {
      anthropic_main: {
        api: "anthropic-messages",
      },
    },
    models: {
      catalog: [
        {
          id: "anthropic_main/claude-sonnet-4-5",
          provider: "anthropic_main",
          upstreamId: "claude-sonnet-4-5-20250929",
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          supportsTools: true,
          supportsVision: true,
          reasoning: { enabled: true },
        },
      ],
      scenarios: {
        chat: ["anthropic_main/claude-sonnet-4-5"],
        compaction: ["anthropic_main/claude-sonnet-4-5"],
        subagent: ["anthropic_main/claude-sonnet-4-5"],
        cron: ["anthropic_main/claude-sonnet-4-5"],
        meditationBucket: [],
        meditationConsolidation: [],
      },
    },
  };
}

function createLifecycle(db: TestDatabaseHandle["storage"]["db"]) {
  return {
    blockTaskExecution: (input: {
      taskRunId: string;
      resultSummary?: string | null;
      finishedAt?: Date;
    }) =>
      blockTaskExecution({
        db,
        ...input,
      }),
    completeTaskExecution: (input: {
      taskRunId: string;
      resultSummary?: string | null;
      finishedAt?: Date;
    }) =>
      completeTaskExecution({
        db,
        ...input,
      }),
    failTaskExecution: (input: {
      taskRunId: string;
      errorText?: string | null;
      resultSummary?: string | null;
      finishedAt?: Date;
    }) =>
      failTaskExecution({
        db,
        ...input,
      }),
    cancelTaskExecution: (input: {
      taskRunId: string;
      cancelledBy: string;
      resultSummary?: string | null;
      finishedAt?: Date;
    }) =>
      cancelTaskExecution({
        db,
        ...input,
      }),
  };
}

describe("TaskExecutionRunner", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("completes a task execution when the run explicitly finishes on the first pass", async () => {
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
          expect(input.afterToolResultHook).toBeDefined();
          expect(input.content).toContain("<task_execution>");
          return makeStartedRun({
            sessionId: created.executionSession.id,
            scenario: "subagent",
            stopSignal: {
              reason: "task_completion",
              payload: {
                taskCompletion: {
                  status: "completed",
                  summary: "Review finished.",
                  finalMessage: "Reviewed the requested files and found no blocking issues.",
                },
              },
            },
          });
        }),
      },
      lifecycle: createLifecycle(db),
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result.status).toBe("completed");
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "completed",
      resultSummary: "Reviewed the requested files and found no blocking issues.",
    });
    expect(result.settled.executionSession).toMatchObject({
      id: created.executionSession.id,
      status: "completed",
    });
  });

  test("completes a task execution through the real ingress and loop path when finish_task is called", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    const db = requireHandle(handle).storage.db;
    const messagesRepo = new MessagesRepo(db);

    const created = createTaskExecution({
      db,
      params: {
        runType: "delegate",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        description: "Run the delegated task and finish explicitly.",
      },
    });

    let turnCount = 0;
    const modelRunner: AgentModelRunner = {
      async runTurn() {
        turnCount += 1;
        return {
          provider: "anthropic_main",
          model: "claude-sonnet-4-5",
          modelApi: "anthropic-messages",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: `finish_${turnCount}`,
              name: "finish_task",
              arguments: {
                status: "completed",
                summary: "Task completed in the first pass.",
                finalMessage: "Finished through the real runtime path.",
              },
            },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
          },
        } as const;
      },
    };

    const tools = new ToolRegistry();
    tools.register(createFinishTaskTool());

    const loop = new AgentLoop({
      sessions: new AgentSessionService(new SessionsRepo(db), messagesRepo),
      messages: messagesRepo,
      models: new ProviderRegistry(createModelConfig()),
      tools,
      cancel: new SessionRunAbortRegistry(),
      modelRunner,
      storage: db,
      securityConfig: DEFAULT_CONFIG.security,
      compaction: DEFAULT_CONFIG.compaction,
    });

    const ingress = new SessionRuntimeIngress({
      loop,
      messages: messagesRepo,
    });

    const runner = new TaskExecutionRunner({
      ingress,
      lifecycle: createLifecycle(db),
      maxSupervisorPasses: 3,
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(turnCount).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "completed",
      resultSummary: "Finished through the real runtime path.",
    });
    expect(result.settled.executionSession).toMatchObject({
      id: created.executionSession.id,
      status: "completed",
    });
  });

  test("retries with a supervisor followup when a pass ends without finish_task", async () => {
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

    const submitMessage = vi
      .fn()
      .mockImplementationOnce(async (input) => {
        expect(input.messageType).toBe("task_kickoff");
        return makeStartedRun({
          sessionId: created.executionSession.id,
          scenario: "subagent",
        });
      })
      .mockImplementationOnce(async (input) => {
        expect(input.messageType).toBe("task_supervisor_followup");
        expect(input.content).toContain("ended without calling finish_task");
        return makeStartedRun({
          sessionId: created.executionSession.id,
          scenario: "subagent",
          stopSignal: {
            reason: "task_completion",
            payload: {
              taskCompletion: {
                status: "completed",
                summary: "Second pass finished the task.",
                finalMessage: "Completed the task after a supervisor reminder.",
              },
            },
          },
        });
      });

    const runner = new TaskExecutionRunner({
      ingress: { submitMessage },
      lifecycle: createLifecycle(db),
      maxSupervisorPasses: 3,
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(submitMessage).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    expect(result.settled.taskRun).toMatchObject({
      status: "completed",
      resultSummary: "Completed the task after a supervisor reminder.",
    });
  });

  test("blocks a task execution when finish_task reports blocked", async () => {
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
        submitMessage: vi.fn(async () =>
          makeStartedRun({
            sessionId: created.executionSession.id,
            scenario: "cron",
            stopSignal: {
              reason: "task_completion",
              payload: {
                taskCompletion: {
                  status: "blocked",
                  summary: "Need credentials.",
                  finalMessage: "The task is blocked until the user provides the API token.",
                },
              },
            },
          }),
        ),
      },
      lifecycle: createLifecycle(db),
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result.status).toBe("blocked");
    expect(result.settled.taskRun).toMatchObject({
      status: "blocked",
      resultSummary: "The task is blocked until the user provides the API token.",
    });
    expect(result.settled.executionSession?.status).toBe("blocked");
  });

  test("fails the task execution after exhausting supervisor passes without finish_task", async () => {
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

    const submitMessage = vi.fn(async (input) =>
      makeStartedRun({
        sessionId: created.executionSession.id,
        scenario: input.scenario as "subagent",
      }),
    );

    const runner = new TaskExecutionRunner({
      ingress: { submitMessage },
      lifecycle: createLifecycle(db),
      maxSupervisorPasses: 3,
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(submitMessage).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: "Task execution ended without calling finish_task after 3 passes.",
    });
    expect(result.settled.taskRun).toMatchObject({
      status: "failed",
      errorText: "Task execution ended without calling finish_task after 3 passes.",
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
      lifecycle: createLifecycle(db),
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
      lifecycle: createLifecycle(db),
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
            "Seeing this message means the daily report task should run now. Summarize what was completed yesterday and generate a report that can be sent directly to the user.",
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
          expect(input.content).toContain(
            "Seeing this message means the daily report task should run now",
          );
          expect(input.content).toContain("<recent_runs>");
          expect(input.content).toContain("<last_run>");
          expect(input.content).toContain("Slack API timeout");
          expect(input.content).toContain("<last_successful_run>");
          expect(input.content).toContain("Posted the daily report with 5 items.");
          expect(input.content).toContain("You are running in background mode");
          expect(input.content).toContain("The final response is the primary user-facing output");
          expect(input.content).toContain("recent_runs and last_run are historical reference only");
          expect(input.content).toContain(
            "They are not evidence that the current run has already completed its required work",
          );
          expect(input.content).toContain(
            "The internal kickoff/reference blocks above are not visible to the user",
          );
          expect(input.content).toContain("Do not tell the user to look at them");
          return makeStartedRun({
            sessionId: created.executionSession.id,
            scenario: "cron",
            stopSignal: {
              reason: "task_completion",
              payload: {
                taskCompletion: {
                  status: "completed",
                  summary: "Daily report sent.",
                  finalMessage: "Published the daily report successfully.",
                },
              },
            },
          });
        }),
      },
      lifecycle: createLifecycle(db),
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
      lifecycle: createLifecycle(db),
    });

    const result = await runner.runCreatedTaskExecution({ created });

    expect(result.status).toBe("failed");
    expect(result.settled.taskRun).toMatchObject({
      id: created.taskRun.id,
      status: "failed",
    });
  });
});
