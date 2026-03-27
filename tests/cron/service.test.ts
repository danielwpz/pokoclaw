import { afterEach, describe, expect, test, vi } from "vitest";

import { CronService } from "@/src/cron/service.js";
import { AgentManager } from "@/src/orchestration/agent-manager.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { TaskExecutionRunResult } from "@/src/tasks/runner.js";
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
    VALUES ('conv_1', 'ci_1', 'chat_1', 'group', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'group_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES ('agent_1', 'conv_1', NULL, 'sub', '2026-03-27T00:00:00.000Z');
  `);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createCompletedRunResult(taskRunId: string): TaskExecutionRunResult {
  return {
    status: "completed",
    started: {
      status: "started",
      messageId: "msg_1",
      run: {
        runId: "loop_run_1",
        sessionId: "sess_task_1",
        scenario: "cron",
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
    },
    settled: {
      taskRun: {
        id: taskRunId,
        runType: "cron",
        ownerAgentId: "agent_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: "cron_1",
        executionSessionId: "sess_task_1",
        status: "completed",
        priority: 0,
        attempt: 1,
        description: null,
        inputJson: "{}",
        resultSummary: "cron finished",
        errorText: null,
        startedAt: "2026-03-27T12:00:00.000Z",
        finishedAt: "2026-03-27T12:00:05.000Z",
        durationMs: 5000,
        cancelledBy: null,
      },
      executionSession: null,
    },
    run: {
      runId: "loop_run_1",
      sessionId: "sess_task_1",
      scenario: "cron",
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
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createStartedIngressResult(sessionId: string): SubmitMessageResult {
  return {
    status: "started",
    messageId: "msg_1",
    run: {
      runId: "loop_run_1",
      sessionId,
      scenario: "cron",
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
}

describe("cron service", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("scanOnce claims a due recurring job, advances next_run_at, and settles state on completion", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'every', '60000', '{}', '2026-03-27T11:59:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const deferred = createDeferred<TaskExecutionRunResult>();
    const runCronTaskExecutionFromJob = vi.fn(() => deferred.promise);

    const service = new CronService({
      storage: handle.storage.db,
      agentManager: { runCronTaskExecutionFromJob },
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    const result = await service.scanOnce();
    expect(result).toMatchObject({
      status: "ran",
      dueJobs: 1,
      claimedJobs: 1,
    });
    expect(runCronTaskExecutionFromJob).toHaveBeenCalledOnce();

    const repo = new CronJobsRepo(handle.storage.db);
    expect(repo.getById("cron_1")).toMatchObject({
      runningAt: "2026-03-27T12:00:00.000Z",
      nextRunAt: "2026-03-27T12:01:00.000Z",
    });

    deferred.resolve(createCompletedRunResult("run_1"));
    await deferred.promise;
    await flushMicrotasks();

    expect(repo.getById("cron_1")).toMatchObject({
      runningAt: null,
      lastStatus: "completed",
      lastOutput: "cron finished",
      nextRunAt: "2026-03-27T12:01:00.000Z",
    });
  });

  test("runJobNow claims immediately without changing the existing schedule", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'cron', '0 8 * * *', '{}', '2026-03-28T00:00:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const deferred = createDeferred<TaskExecutionRunResult>();
    const runCronTaskExecutionFromJob = vi.fn(() => deferred.promise);

    const service = new CronService({
      storage: handle.storage.db,
      agentManager: { runCronTaskExecutionFromJob },
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.runJobNow("cron_1");

    const repo = new CronJobsRepo(handle.storage.db);
    expect(repo.getById("cron_1")).toMatchObject({
      runningAt: "2026-03-27T12:00:00.000Z",
      nextRunAt: "2026-03-28T00:00:00.000Z",
    });

    deferred.resolve(createCompletedRunResult("run_2"));
    await deferred.promise;
    await flushMicrotasks();

    expect(repo.getById("cron_1")).toMatchObject({
      runningAt: null,
      lastStatus: "completed",
      nextRunAt: "2026-03-28T00:00:00.000Z",
    });
  });

  test("scanOnce does not double-start a job that is already running", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'every', '60000', '{}', '2026-03-27T11:59:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const deferred = createDeferred<TaskExecutionRunResult>();
    const runCronTaskExecutionFromJob = vi.fn(() => deferred.promise);

    const service = new CronService({
      storage: handle.storage.db,
      agentManager: { runCronTaskExecutionFromJob },
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.scanOnce();
    await service.scanOnce();

    expect(runCronTaskExecutionFromJob).toHaveBeenCalledTimes(1);

    deferred.resolve(createCompletedRunResult("run_3"));
    await deferred.promise;
    await flushMicrotasks();
  });

  test("manual run is allowed for disabled jobs", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, enabled, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'every', '60000', 0, '{}', '2026-03-28T00:00:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const deferred = createDeferred<TaskExecutionRunResult>();
    const runCronTaskExecutionFromJob = vi.fn(() => deferred.promise);

    const service = new CronService({
      storage: handle.storage.db,
      agentManager: { runCronTaskExecutionFromJob },
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.runJobNow("cron_1");
    expect(runCronTaskExecutionFromJob).toHaveBeenCalledOnce();

    deferred.resolve(createCompletedRunResult("run_4"));
    await deferred.promise;
    await flushMicrotasks();
  });

  test("one-shot due job disables itself after completion", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'at', '2026-03-27T11:59:00.000Z', '{}', '2026-03-27T11:59:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const deferred = createDeferred<TaskExecutionRunResult>();
    const runCronTaskExecutionFromJob = vi.fn(() => deferred.promise);

    const service = new CronService({
      storage: handle.storage.db,
      agentManager: { runCronTaskExecutionFromJob },
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.scanOnce();

    const repo = new CronJobsRepo(handle.storage.db);
    expect(repo.getById("cron_1")).toMatchObject({
      runningAt: "2026-03-27T12:00:00.000Z",
      nextRunAt: null,
    });

    deferred.resolve(createCompletedRunResult("run_5"));
    await deferred.promise;
    await flushMicrotasks();

    expect(repo.getById("cron_1")).toMatchObject({
      enabled: false,
      runningAt: null,
      lastStatus: "completed",
      nextRunAt: null,
    });
  });

  test("rejects creating a one-shot job in the past", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);

    const service = new CronService({
      storage: handle.storage.db,
      agentManager: {
        runCronTaskExecutionFromJob: vi.fn(async () => createCompletedRunResult("unused")),
      },
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    expect(() =>
      service.add({
        ownerAgentId: "agent_1",
        targetConversationId: "conv_1",
        targetBranchId: "branch_1",
        scheduleKind: "at",
        scheduleValue: "2026-03-27T11:00:00.000Z",
        payloadJson: "{}",
      }),
    ).toThrow(/future time/i);
  });

  test("records cron job, task_run, and task session state through a successful run", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'every', '60000', '{}', '2026-03-27T11:59:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const deferred = createDeferred<SubmitMessageResult>();
    const submitMessage = vi.fn((_: SubmitMessageInput) => deferred.promise);
    const manager = new AgentManager({
      storage: handle.storage.db,
      ingress: {
        submitMessage,
        submitApprovalDecision: vi.fn(() => false),
      },
    });
    const service = new CronService({
      storage: handle.storage.db,
      agentManager: manager,
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.scanOnce();

    const cronRepo = new CronJobsRepo(handle.storage.db);
    const taskRunsRepo = new TaskRunsRepo(handle.storage.db);
    const sessionsRepo = new SessionsRepo(handle.storage.db);

    const runningJob = cronRepo.getById("cron_1");
    expect(runningJob).toMatchObject({
      runningAt: "2026-03-27T12:00:00.000Z",
      nextRunAt: "2026-03-27T12:01:00.000Z",
    });

    const runningTaskRun = taskRunsRepo.listByOwner("agent_1", 10)[0];
    if (runningTaskRun == null) {
      throw new Error("Expected a running cron task_run to be created");
    }
    expect(runningTaskRun).toMatchObject({
      runType: "cron",
      cronJobId: "cron_1",
      status: "running",
    });
    expect(runningTaskRun.executionSessionId).toBeTruthy();
    expect(sessionsRepo.getById(runningTaskRun.executionSessionId as string)).toMatchObject({
      purpose: "task",
      status: "active",
    });

    const sessionId = submitMessage.mock.calls[0]?.[0]?.sessionId as string;
    deferred.resolve(createStartedIngressResult(sessionId));
    await deferred.promise;
    await flushMicrotasks();

    const settledTaskRun = taskRunsRepo.getById(runningTaskRun.id);
    expect(settledTaskRun).toMatchObject({
      status: "completed",
    });
    expect(sessionsRepo.getById(runningTaskRun.executionSessionId as string)).toMatchObject({
      status: "completed",
    });
    expect(cronRepo.getById("cron_1")).toMatchObject({
      runningAt: null,
      lastStatus: "completed",
    });
  });

  test("records failed state when cron kickoff fails", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'every', '60000', '{}', '2026-03-27T11:59:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const manager = new AgentManager({
      storage: handle.storage.db,
      ingress: {
        submitMessage: vi.fn(async () => {
          throw new Error("LLM unavailable");
        }),
        submitApprovalDecision: vi.fn(() => false),
      },
    });
    const service = new CronService({
      storage: handle.storage.db,
      agentManager: manager,
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.scanOnce();
    await flushMicrotasks();

    const taskRun = new TaskRunsRepo(handle.storage.db).listByOwner("agent_1", 10)[0];
    expect(taskRun).toMatchObject({
      runType: "cron",
      status: "failed",
      errorText: "LLM unavailable",
    });
    expect(new CronJobsRepo(handle.storage.db).getById("cron_1")).toMatchObject({
      runningAt: null,
      lastStatus: "failed",
      lastOutput: "LLM unavailable",
    });
  });

  test("records cancelled state when cron kickoff is aborted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedFixture(handle);
    handle.storage.sqlite.exec(`
      INSERT INTO cron_jobs (
        id, owner_agent_id, target_conversation_id, target_branch_id,
        schedule_kind, schedule_value, payload_json, next_run_at, created_at, updated_at
      ) VALUES (
        'cron_1', 'agent_1', 'conv_1', 'branch_1',
        'every', '60000', '{}', '2026-03-27T11:59:00.000Z',
        '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z'
      );
    `);

    const manager = new AgentManager({
      storage: handle.storage.db,
      ingress: {
        submitMessage: vi.fn(async () => {
          throw new Error("stop requested by user");
        }),
        submitApprovalDecision: vi.fn(() => false),
      },
    });
    const service = new CronService({
      storage: handle.storage.db,
      agentManager: manager,
      now: () => new Date("2026-03-27T12:00:00.000Z"),
    });

    await service.scanOnce();
    await flushMicrotasks();

    const taskRun = new TaskRunsRepo(handle.storage.db).listByOwner("agent_1", 10)[0];
    expect(taskRun).toMatchObject({
      runType: "cron",
      status: "cancelled",
      cancelledBy: "system:task_runner",
    });
    expect(new CronJobsRepo(handle.storage.db).getById("cron_1")).toMatchObject({
      runningAt: null,
      lastStatus: "cancelled",
      lastOutput: "stop requested by user",
    });
  });
});
