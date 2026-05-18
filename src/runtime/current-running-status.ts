import { resolveSessionLiveState } from "@/src/runtime/live-state.js";
import type { RunLiveObservabilitySnapshot } from "@/src/runtime/run-observability.js";
import { detectRuntimeShellInfo, type RuntimeShellInfo } from "@/src/runtime/shell-info.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { Agent, CronJob, Session, TaskRun } from "@/src/storage/schema/types.js";
import { parseBackgroundTaskPayload } from "@/src/tasks/background-task-payload.js";

const TASK_PREVIEW_CHARS = 240;

export type CurrentRunningWorkKind =
  | "main_chat"
  | "subagent_chat"
  | "approval"
  | "background_task"
  | "cron_task"
  | "task_run"
  | "run";

export interface CurrentRunningAgentSnapshot {
  id: string;
  kind: string;
  displayName: string | null;
  mainAgentId: string | null;
}

export interface CurrentRunningSessionSnapshot {
  id: string;
  purpose: string;
  status: string;
  conversationId: string;
  branchId: string;
  ownerAgentId: string | null;
}

export interface CurrentRunningTaskRunSnapshot {
  id: string;
  runType: string;
  status: string;
  description: string | null;
  startedAt: string;
  executionSessionId: string | null;
  initiatorSessionId: string | null;
  parentRunId: string | null;
  cronJobId: string | null;
}

export interface CurrentRunningCronJobSnapshot {
  id: string;
  name: string | null;
  scheduleKind: string;
  scheduleValue: string;
  timezone: string | null;
  runningAt: string | null;
  nextRunAt: string | null;
}

export interface CurrentRunningBackgroundTaskSnapshot {
  taskDefinitionPreview: string;
}

export interface CurrentRunningWorkItem {
  kind: CurrentRunningWorkKind;
  runId: string;
  liveRun: RunLiveObservabilitySnapshot;
  ownerAgent: CurrentRunningAgentSnapshot | null;
  session: CurrentRunningSessionSnapshot | null;
  taskRun: CurrentRunningTaskRunSnapshot | null;
  cronJob: CurrentRunningCronJobSnapshot | null;
  backgroundTask: CurrentRunningBackgroundTaskSnapshot | null;
}

export interface SuspectRunningTaskRunItem {
  reason: "running_task_run_without_live_run";
  ownerAgent: CurrentRunningAgentSnapshot | null;
  taskRun: CurrentRunningTaskRunSnapshot;
  cronJob: CurrentRunningCronJobSnapshot | null;
  backgroundTask: CurrentRunningBackgroundTaskSnapshot | null;
}

export interface SuspectRunningCronJobItem {
  reason: "running_cron_job_without_running_task_run";
  ownerAgent: CurrentRunningAgentSnapshot | null;
  cronJob: CurrentRunningCronJobSnapshot;
}

export interface CurrentRunningRuntimeStatusSnapshot {
  now: string;
  scope: "global_current_running";
  runtimeEnvironment: RuntimeShellInfo;
  runningWork: CurrentRunningWorkItem[];
  suspectRunningTaskRuns: SuspectRunningTaskRunItem[];
  suspectRunningCronJobs: SuspectRunningCronJobItem[];
}

export interface RuntimeRunStatusSnapshot {
  now: string;
  found: true;
  runtimeEnvironment: RuntimeShellInfo;
  run: CurrentRunningWorkItem;
}

export function buildCurrentRunningRuntimeStatus(input: {
  storage: StorageDb;
  now: string;
  liveRuns: RunLiveObservabilitySnapshot[];
}): CurrentRunningRuntimeStatusSnapshot {
  return input.storage.transaction((tx) => {
    const repos = createRepos(tx);
    const runningTaskRuns = repos.taskRuns.listRunning();
    const runningCronJobs = repos.cronJobs.listRunning();
    const runningWork = input.liveRuns.map((run) => buildRunningWorkItem({ repos, run }));
    const liveSessionIds = new Set(input.liveRuns.map((run) => run.sessionId));
    const representedTaskRunIds = new Set(
      runningWork.map((item) => item.taskRun?.id).filter((id): id is string => id != null),
    );
    const representedCronJobIds = new Set(
      runningWork.map((item) => item.cronJob?.id).filter((id): id is string => id != null),
    );

    const suspectRunningTaskRuns = runningTaskRuns
      .filter((taskRun) => {
        if (representedTaskRunIds.has(taskRun.id)) {
          return false;
        }
        return (
          taskRun.executionSessionId == null || !liveSessionIds.has(taskRun.executionSessionId)
        );
      })
      .map((taskRun) => {
        const ownerAgent = repos.agents.getById(taskRun.ownerAgentId);
        const cronJob =
          taskRun.cronJobId == null
            ? null
            : repos.cronJobs.getByIdIncludingDeleted(taskRun.cronJobId);
        if (cronJob != null) {
          representedCronJobIds.add(cronJob.id);
        }

        return {
          reason: "running_task_run_without_live_run" as const,
          ownerAgent: toAgentSnapshot(ownerAgent),
          taskRun: toRequiredTaskRunSnapshot(taskRun),
          cronJob: toCronJobSnapshot(cronJob),
          backgroundTask: toBackgroundTaskSnapshot(taskRun),
        };
      });

    const runningTaskCronJobIds = new Set(
      runningTaskRuns.map((taskRun) => taskRun.cronJobId).filter((id): id is string => id != null),
    );
    const suspectRunningCronJobs = runningCronJobs
      .filter((cronJob) => {
        if (representedCronJobIds.has(cronJob.id)) {
          return false;
        }
        return !runningTaskCronJobIds.has(cronJob.id);
      })
      .map((cronJob) => ({
        reason: "running_cron_job_without_running_task_run" as const,
        ownerAgent: toAgentSnapshot(repos.agents.getById(cronJob.ownerAgentId)),
        cronJob: toRequiredCronJobSnapshot(cronJob),
      }));

    return {
      now: input.now,
      scope: "global_current_running",
      runtimeEnvironment: detectRuntimeShellInfo(),
      runningWork,
      suspectRunningTaskRuns,
      suspectRunningCronJobs,
    };
  });
}

export function buildRuntimeRunStatus(input: {
  storage: StorageDb;
  now: string;
  run: RunLiveObservabilitySnapshot;
}): RuntimeRunStatusSnapshot {
  return {
    now: input.now,
    found: true,
    runtimeEnvironment: detectRuntimeShellInfo(),
    run: buildRunningWorkItem({
      repos: createRepos(input.storage),
      run: input.run,
    }),
  };
}

function buildRunningWorkItem(input: {
  repos: RuntimeStatusRepos;
  run: RunLiveObservabilitySnapshot;
}): CurrentRunningWorkItem {
  const live = resolveSessionLiveState({
    db: input.repos.storage,
    sessionId: input.run.sessionId,
  });
  const session = live?.session ?? null;
  const taskRun = live?.taskRun ?? null;
  const ownerAgent =
    live?.ownerAgentId == null ? null : input.repos.agents.getById(live.ownerAgentId);
  const cronJob =
    taskRun?.cronJobId == null
      ? null
      : input.repos.cronJobs.getByIdIncludingDeleted(taskRun.cronJobId);
  const backgroundTask = taskRun == null ? null : toBackgroundTaskSnapshot(taskRun);

  return {
    kind: classifyWork({
      session,
      ownerAgent,
      taskRun,
      cronJob,
      hasBackgroundTask: backgroundTask != null,
    }),
    runId: input.run.runId,
    liveRun: input.run,
    ownerAgent: toAgentSnapshot(ownerAgent),
    session: toSessionSnapshot(session),
    taskRun: toTaskRunSnapshot(taskRun),
    cronJob: toCronJobSnapshot(cronJob),
    backgroundTask,
  };
}

interface RuntimeStatusRepos {
  storage: StorageDb;
  agents: AgentsRepo;
  taskRuns: TaskRunsRepo;
  cronJobs: CronJobsRepo;
}

function createRepos(storage: StorageDb): RuntimeStatusRepos {
  return {
    storage,
    agents: new AgentsRepo(storage),
    taskRuns: new TaskRunsRepo(storage),
    cronJobs: new CronJobsRepo(storage),
  };
}

function classifyWork(input: {
  session: Session | null;
  ownerAgent: Agent | null;
  taskRun: TaskRun | null;
  cronJob: CronJob | null;
  hasBackgroundTask: boolean;
}): CurrentRunningWorkKind {
  if (input.cronJob != null || input.taskRun?.runType === "cron") {
    return "cron_task";
  }
  if (input.hasBackgroundTask) {
    return "background_task";
  }
  if (input.taskRun != null) {
    return "task_run";
  }
  if (input.session?.purpose === "approval") {
    return "approval";
  }
  if (input.session?.purpose === "chat" && input.ownerAgent?.kind === "main") {
    return "main_chat";
  }
  if (input.session?.purpose === "chat" && input.ownerAgent?.kind === "sub") {
    return "subagent_chat";
  }
  return "run";
}

function toAgentSnapshot(agent: Agent | null): CurrentRunningAgentSnapshot | null {
  if (agent == null) {
    return null;
  }
  return {
    id: agent.id,
    kind: agent.kind,
    displayName: agent.displayName,
    mainAgentId: agent.mainAgentId,
  };
}

function toSessionSnapshot(session: Session | null): CurrentRunningSessionSnapshot | null {
  if (session == null) {
    return null;
  }
  return {
    id: session.id,
    purpose: session.purpose,
    status: session.status,
    conversationId: session.conversationId,
    branchId: session.branchId,
    ownerAgentId: session.ownerAgentId,
  };
}

function toTaskRunSnapshot(taskRun: TaskRun | null): CurrentRunningTaskRunSnapshot | null {
  if (taskRun == null) {
    return null;
  }
  return toRequiredTaskRunSnapshot(taskRun);
}

function toRequiredTaskRunSnapshot(taskRun: TaskRun): CurrentRunningTaskRunSnapshot {
  return {
    id: taskRun.id,
    runType: taskRun.runType,
    status: taskRun.status,
    description: taskRun.description,
    startedAt: taskRun.startedAt,
    executionSessionId: taskRun.executionSessionId,
    initiatorSessionId: taskRun.initiatorSessionId,
    parentRunId: taskRun.parentRunId,
    cronJobId: taskRun.cronJobId,
  };
}

function toCronJobSnapshot(cronJob: CronJob | null): CurrentRunningCronJobSnapshot | null {
  if (cronJob == null) {
    return null;
  }
  return toRequiredCronJobSnapshot(cronJob);
}

function toRequiredCronJobSnapshot(cronJob: CronJob): CurrentRunningCronJobSnapshot {
  return {
    id: cronJob.id,
    name: cronJob.name,
    scheduleKind: cronJob.scheduleKind,
    scheduleValue: cronJob.scheduleValue,
    timezone: cronJob.timezone,
    runningAt: cronJob.runningAt,
    nextRunAt: cronJob.nextRunAt,
  };
}

function toBackgroundTaskSnapshot(taskRun: TaskRun): CurrentRunningBackgroundTaskSnapshot | null {
  const payload = parseBackgroundTaskPayload(taskRun.inputJson);
  if (payload == null) {
    return null;
  }
  return {
    taskDefinitionPreview: truncateText(payload.taskDefinition, TASK_PREVIEW_CHARS),
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 3)}...`;
}
