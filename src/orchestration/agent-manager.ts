/**
 * Top-level orchestration coordinator.
 *
 * AgentManager is the cross-session control plane above runtime loop execution.
 * It routes runtime events, manages delegated approvals, drives task/cron runs,
 * and publishes channel-facing outbound envelopes.
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import { extractCronTaskDefinition } from "@/src/cron/payload.js";
import { CronService } from "@/src/cron/service.js";
import {
  type DelegatedApprovalDeliveryResult,
  deliverDelegatedApprovalRequest,
} from "@/src/orchestration/delegated-approval.js";
import {
  type OrchestratedOutboundEventEnvelope,
  type OrchestratedRuntimeEventEnvelope,
  projectRuntimeEvent,
  projectSubagentCreationEvent,
  projectTaskRunEvent,
} from "@/src/orchestration/outbound-events.js";
import {
  type ApproveSubagentCreationRequestInput,
  type CreatedSubagent,
  type CreateSubagentInput,
  type DenySubagentCreationRequestInput,
  type SubagentConversationSurfaceProvisioner,
  SubagentManager,
  type SubagentPrivateWorkspaceManager,
  type SubmittedSubagentCreationRequest,
} from "@/src/orchestration/subagents.js";
import {
  type CreatedTaskExecution,
  type CreateTaskExecutionInput,
  createTaskExecution,
} from "@/src/orchestration/task-run-factory.js";
import {
  blockTaskExecution,
  cancelTaskExecution,
  completeTaskExecution,
  failTaskExecution,
  type SettledTaskExecution,
} from "@/src/orchestration/task-run-lifecycle.js";
import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import type { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import {
  type ResolvedSessionLiveState,
  type ResolvedTaskRunLiveState,
  resolveAgentOwnershipState,
  resolveSessionLiveState,
  resolveTaskRunLiveState,
} from "@/src/runtime/live-state.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ConversationsRepo } from "@/src/storage/repos/conversations.repo.js";
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { SubagentCreationRequestsRepo } from "@/src/storage/repos/subagent-creation-requests.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { TaskWorkstreamsRepo } from "@/src/storage/repos/task-workstreams.repo.js";
import type { SubagentCreationRequest, TaskRun } from "@/src/storage/schema/types.js";
import {
  buildBackgroundTaskPayload,
  parseBackgroundTaskPayload,
} from "@/src/tasks/background-task-payload.js";
import { TaskExecutionRunner, type TaskExecutionRunResult } from "@/src/tasks/runner.js";

const logger = createSubsystemLogger("orchestration/agent-manager");

export interface AgentManagerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
  submitApprovalDecision(input: ApprovalResponseInput): boolean;
}

export interface AgentManagerDependencies {
  storage: StorageDb;
  ingress: AgentManagerIngress;
  outboundEventBus?: RuntimeEventBus<OrchestratedOutboundEventEnvelope>;
  subagentProvisioner?: SubagentConversationSurfaceProvisioner;
  subagentPrivateWorkspace?: SubagentPrivateWorkspaceManager;
}

export interface ResolveSubagentCreationRequestResult {
  outcome:
    | "created"
    | "denied"
    | "already_created"
    | "already_denied"
    | "already_failed"
    | "already_expired"
    | "provisioning";
  request: SubagentCreationRequest;
  externalChatId: string | null;
  shareLink: string | null;
}

interface PendingBackgroundTaskCompletionNotice {
  taskRunId: string;
  sourceSessionId: string;
  content: string;
  createdAt: Date;
}

// AgentManager is the orchestration-facing runtime entrypoint.
// It sits above session-local runtime ingress and handles cross-session
// coordination such as delegated approvals without pulling that logic into
// AgentLoop or session lanes.
export class AgentManager {
  private readonly inflightRuntimeEventTasks = new Set<Promise<void>>();
  private readonly suppressedBackgroundTaskCompletionNotices = new Set<string>();
  private readonly activeSessionRuns = new Set<string>();
  private readonly pendingBackgroundTaskCompletionNotices = new Map<
    string,
    PendingBackgroundTaskCompletionNotice[]
  >();

  constructor(private readonly deps: AgentManagerDependencies) {}

  submitUserMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
    this.flushBackgroundTaskCompletionNoticesForSession({
      sessionId: input.sessionId,
      trigger: "submit_user_message",
    });
    return this.deps.ingress.submitMessage(input);
  }

  submitApprovalDecision(input: ApprovalResponseInput): boolean {
    return this.deps.ingress.submitApprovalDecision(input);
  }

  getSessionLiveState(sessionId: string): ResolvedSessionLiveState | null {
    return resolveSessionLiveState({
      db: this.deps.storage,
      sessionId,
    });
  }

  getTaskRunLiveState(taskRunId: string): ResolvedTaskRunLiveState | null {
    return resolveTaskRunLiveState({
      db: this.deps.storage,
      taskRunId,
    });
  }

  projectRuntimeEvent(event: AgentRuntimeEvent): OrchestratedRuntimeEventEnvelope {
    return projectRuntimeEvent({
      db: this.deps.storage,
      event,
    });
  }

  createTaskExecution(params: CreateTaskExecutionInput): CreatedTaskExecution {
    const ownership = resolveAgentOwnershipState({
      db: this.deps.storage,
      agentId: params.ownerAgentId,
    });
    if (ownership == null) {
      throw new Error(`Cannot create task execution for unknown agent ${params.ownerAgentId}`);
    }

    const workstreamId =
      params.workstreamId ??
      this.createTaskWorkstream({
        ownerAgentId: params.ownerAgentId,
        conversationId: params.conversationId,
        branchId: params.branchId,
        ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
      }).id;

    const created = createTaskExecution({
      db: this.deps.storage,
      params: {
        ...params,
        workstreamId,
      },
    });

    logger.info("created task execution", {
      taskRunId: created.taskRun.id,
      executionSessionId: created.executionSession.id,
      runType: created.taskRun.runType,
      ownerAgentId: created.taskRun.ownerAgentId,
      mainAgentId: ownership.mainAgentId,
      conversationId: created.taskRun.conversationId,
      branchId: created.taskRun.branchId,
    });

    this.publishOutboundEvent(
      projectTaskRunEvent({
        db: this.deps.storage,
        event: {
          type: "task_run_started",
          taskRunId: created.taskRun.id,
          runType: created.taskRun.runType,
          status: created.taskRun.status,
          startedAt: created.taskRun.startedAt,
          initiatorSessionId: created.taskRun.initiatorSessionId,
          parentRunId: created.taskRun.parentRunId,
          cronJobId: created.taskRun.cronJobId,
          executionSessionId: created.taskRun.executionSessionId,
        },
        taskRun: created.taskRun,
        executionSession: created.executionSession,
      }),
    );

    return created;
  }

  createTaskWorkstream(input: {
    ownerAgentId: string;
    conversationId: string;
    branchId: string;
    createdAt?: Date;
  }) {
    return new TaskWorkstreamsRepo(this.deps.storage).create({
      id: randomUUID(),
      ownerAgentId: input.ownerAgentId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      ...(input.createdAt === undefined
        ? {}
        : { createdAt: input.createdAt, updatedAt: input.createdAt }),
    });
  }

  createTaskThreadFollowupExecution(input: {
    rootTaskRunId: string;
    initiatorThreadId?: string | null;
    createdAt?: Date;
  }): CreatedTaskExecution {
    const taskRunsRepo = new TaskRunsRepo(this.deps.storage);
    const sessionsRepo = new SessionsRepo(this.deps.storage);
    const cronJobsRepo = new CronJobsRepo(this.deps.storage);
    const rootRun = taskRunsRepo.getById(input.rootTaskRunId);
    if (rootRun == null) {
      throw new Error(
        `Cannot create follow-up task execution for unknown root task run ${input.rootTaskRunId}`,
      );
    }

    const latestRun = taskRunsRepo.findLatestByThreadRootRunId(input.rootTaskRunId);
    const latestSession =
      latestRun?.executionSessionId == null
        ? null
        : sessionsRepo.getById(latestRun.executionSessionId);
    const inheritedDescription =
      latestRun?.description ??
      (latestRun?.cronJobId == null ? null : cronJobsRepo.getById(latestRun.cronJobId)?.name) ??
      null;
    return this.createTaskExecution({
      runType: "thread",
      ownerAgentId: rootRun.ownerAgentId,
      conversationId: rootRun.conversationId,
      branchId: rootRun.branchId,
      workstreamId: latestRun?.workstreamId ?? rootRun.workstreamId ?? null,
      threadRootRunId: input.rootTaskRunId,
      initiatorThreadId: input.initiatorThreadId ?? null,
      parentRunId: latestRun?.id ?? null,
      forkSourceSessionId: latestRun?.executionSessionId ?? null,
      contextMode: latestSession?.contextMode ?? "isolated",
      description: inheritedDescription,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  }

  submitSubagentCreationRequest(params: CreateSubagentInput): SubmittedSubagentCreationRequest {
    const manager = new SubagentManager({
      storage: this.deps.storage,
      ingress: this.deps.ingress,
      ...(this.deps.subagentPrivateWorkspace == null
        ? {}
        : { privateWorkspace: this.deps.subagentPrivateWorkspace }),
      ...(this.deps.subagentProvisioner == null
        ? {}
        : { provisioner: this.deps.subagentProvisioner }),
    });
    const submitted = manager.submitCreateRequest(params);
    this.publishOutboundEvent(
      projectSubagentCreationEvent({
        db: this.deps.storage,
        request: submitted.request,
        event: {
          type: "subagent_creation_requested",
          requestId: submitted.request.id,
          title: submitted.request.title,
          description: submitted.request.description,
          workdir: submitted.request.workdir,
          expiresAt: submitted.request.expiresAt,
        },
      }),
    );
    return submitted;
  }

  approveSubagentCreationRequest(
    input: ApproveSubagentCreationRequestInput,
  ): Promise<CreatedSubagent> {
    if (this.deps.subagentProvisioner == null) {
      throw new Error("Cannot create subagents without a configured conversation provisioner");
    }

    const manager = new SubagentManager({
      storage: this.deps.storage,
      ingress: this.deps.ingress,
      provisioner: this.deps.subagentProvisioner,
      ...(this.deps.subagentPrivateWorkspace == null
        ? {}
        : { privateWorkspace: this.deps.subagentPrivateWorkspace }),
    });
    return manager.approveCreateRequest(input).then(
      (created) => {
        const request = new SubagentCreationRequestsRepo(this.deps.storage).getById(
          input.requestId,
        );
        if (request != null) {
          this.publishResolvedSubagentRequestEvent({
            request,
            externalChatId: created.externalChatId,
            shareLink: created.shareLink,
          });
        }
        return created;
      },
      (error: unknown) => {
        const request = new SubagentCreationRequestsRepo(this.deps.storage).getById(
          input.requestId,
        );
        if (request != null) {
          this.publishResolvedSubagentRequestEvent({
            request,
            externalChatId: null,
            shareLink: null,
          });
        }
        throw error;
      },
    );
  }

  denySubagentCreationRequest(input: DenySubagentCreationRequestInput) {
    const manager = new SubagentManager({
      storage: this.deps.storage,
      ingress: this.deps.ingress,
      ...(this.deps.subagentPrivateWorkspace == null
        ? {}
        : { privateWorkspace: this.deps.subagentPrivateWorkspace }),
      ...(this.deps.subagentProvisioner == null
        ? {}
        : { provisioner: this.deps.subagentProvisioner }),
    });
    const denied = manager.denyCreateRequest(input);
    this.publishResolvedSubagentRequestEvent({
      request: denied,
      externalChatId: null,
      shareLink: null,
    });
    return denied;
  }

  async resolveApproveSubagentCreationRequest(
    input: ApproveSubagentCreationRequestInput,
  ): Promise<ResolveSubagentCreationRequestResult> {
    const decidedAt = input.decidedAt ?? new Date();
    const request = this.getCurrentSubagentRequestForDecision(input.requestId, decidedAt);
    if (request.status === "pending") {
      const created = await this.approveSubagentCreationRequest({
        requestId: input.requestId,
        decidedAt,
      });
      const updated = this.requireSubagentRequest(input.requestId);
      return {
        outcome: "created",
        request: updated,
        externalChatId: created.externalChatId,
        shareLink: created.shareLink,
      };
    }

    if (request.status === "provisioning") {
      return {
        outcome: "provisioning",
        request,
        externalChatId: null,
        shareLink: null,
      };
    }

    const createdSurface = this.resolveCreatedSubagentSurface(request);
    this.publishResolvedSubagentRequestEvent({
      request,
      externalChatId: createdSurface.externalChatId,
      shareLink: createdSurface.shareLink,
    });
    return {
      outcome: toResolvedApproveOutcome(request.status),
      request,
      externalChatId: createdSurface.externalChatId,
      shareLink: createdSurface.shareLink,
    };
  }

  resolveDenySubagentCreationRequest(
    input: DenySubagentCreationRequestInput,
  ): ResolveSubagentCreationRequestResult {
    const decidedAt = input.decidedAt ?? new Date();
    const request = this.getCurrentSubagentRequestForDecision(input.requestId, decidedAt);
    if (request.status === "pending") {
      const denied = this.denySubagentCreationRequest({
        requestId: input.requestId,
        decidedAt,
        ...(input.reasonText === undefined ? {} : { reasonText: input.reasonText }),
      });
      return {
        outcome: "denied",
        request: denied,
        externalChatId: null,
        shareLink: null,
      };
    }

    if (request.status === "provisioning") {
      return {
        outcome: "provisioning",
        request,
        externalChatId: null,
        shareLink: null,
      };
    }

    const createdSurface = this.resolveCreatedSubagentSurface(request);
    this.publishResolvedSubagentRequestEvent({
      request,
      externalChatId: createdSurface.externalChatId,
      shareLink: createdSurface.shareLink,
    });
    return {
      outcome: toResolvedDenyOutcome(request.status),
      request,
      externalChatId: createdSurface.externalChatId,
      shareLink: createdSurface.shareLink,
    };
  }

  createCronTaskExecutionFromJob(input: {
    cronJobId: string;
    createdAt?: Date;
    attempt?: number;
  }): CreatedTaskExecution {
    const cronJobsRepo = new CronJobsRepo(this.deps.storage);
    const taskRunsRepo = new TaskRunsRepo(this.deps.storage);
    const sessionsRepo = new SessionsRepo(this.deps.storage);
    let cronJob = cronJobsRepo.getById(input.cronJobId);
    if (cronJob == null) {
      throw new Error(`Cannot create task execution for unknown cron job ${input.cronJobId}`);
    }

    if (cronJob.workstreamId == null) {
      const workstream = this.createTaskWorkstream({
        ownerAgentId: cronJob.ownerAgentId,
        conversationId: cronJob.targetConversationId,
        branchId: cronJob.targetBranchId,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      });
      cronJob = cronJobsRepo.updateWorkstreamId({
        id: cronJob.id,
        workstreamId: workstream.id,
      });
      if (cronJob == null) {
        throw new Error(`Cron job ${input.cronJobId} disappeared while attaching a workstream`);
      }
    }

    const recentRuns = taskRunsRepo.listByCronJobId(cronJob.id, 8);
    const lastSettledRun = recentRuns.find((run) => run.status !== "running") ?? null;
    const lastSuccessfulRun =
      recentRuns.find((run) => run.status === "completed" && run.id !== lastSettledRun?.id) ??
      (lastSettledRun?.status === "completed" ? lastSettledRun : null);

    const cronInput = {
      taskDefinition: extractCronTaskDefinition(cronJob.payloadJson),
    };
    const inputJson = JSON.stringify({
      ...cronInput,
      recentRuns: {
        lastRun: lastSettledRun == null ? null : summarizeCronTaskRunForKickoff(lastSettledRun),
        lastSuccessfulRun:
          lastSuccessfulRun == null ? null : summarizeCronTaskRunForKickoff(lastSuccessfulRun),
      },
    });
    const forkSourceSession =
      cronJob.contextMode === "group"
        ? sessionsRepo.findLatestByConversationBranch(
            cronJob.targetConversationId,
            cronJob.targetBranchId,
            {
              purpose: "chat",
            },
          )
        : null;

    const created = this.createTaskExecution({
      runType: "cron",
      ownerAgentId: cronJob.ownerAgentId,
      conversationId: cronJob.targetConversationId,
      branchId: cronJob.targetBranchId,
      workstreamId: cronJob.workstreamId ?? null,
      forkSourceSessionId: forkSourceSession?.id ?? null,
      cronJobId: cronJob.id,
      contextMode: cronJob.contextMode,
      inputJson,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });

    logger.info("created cron task execution", {
      cronJobId: cronJob.id,
      taskRunId: created.taskRun.id,
      executionSessionId: created.executionSession.id,
      ownerAgentId: created.taskRun.ownerAgentId,
      conversationId: created.taskRun.conversationId,
      branchId: created.taskRun.branchId,
    });

    return created;
  }

  runCreatedTaskExecution(input: {
    created: CreatedTaskExecution;
    createdAt?: Date;
  }): Promise<TaskExecutionRunResult> {
    return this.createTaskExecutionRunner().runCreatedTaskExecution(input);
  }

  runTaskExecution(params: CreateTaskExecutionInput): Promise<TaskExecutionRunResult> {
    const created = this.createTaskExecution(params);
    return this.runCreatedTaskExecution({
      created,
      ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
    });
  }

  runCronTaskExecutionFromJob(input: {
    cronJobId: string;
    createdAt?: Date;
    attempt?: number;
  }): Promise<TaskExecutionRunResult> {
    const created = this.createCronTaskExecutionFromJob(input);
    return this.runCreatedTaskExecution({
      created,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  }

  runCronJobNow(input: { jobId: string }) {
    return new CronService({
      storage: this.deps.storage,
      agentManager: this,
    }).runJobNow(input.jobId);
  }

  async startBackgroundTask(input: {
    sourceSessionId: string;
    description: string;
    task: string;
    contextMode?: "isolated" | "group";
  }): Promise<{
    accepted: boolean;
    taskRunId: string;
  }> {
    const sessionsRepo = new SessionsRepo(this.deps.storage);
    const agentsRepo = new AgentsRepo(this.deps.storage);
    const sourceSession = sessionsRepo.getById(input.sourceSessionId);
    if (sourceSession == null) {
      throw new Error(`Cannot start background task from unknown session ${input.sourceSessionId}`);
    }
    if (sourceSession.purpose !== "chat") {
      throw new Error(
        `Cannot start background task from non-chat session ${sourceSession.id} (${sourceSession.purpose})`,
      );
    }
    if (sourceSession.ownerAgentId == null) {
      throw new Error(`Cannot start background task from unowned session ${sourceSession.id}`);
    }

    const ownerAgent = agentsRepo.getById(sourceSession.ownerAgentId);
    if (ownerAgent == null || (ownerAgent.kind !== "main" && ownerAgent.kind !== "sub")) {
      throw new Error(
        `Cannot start background task from unsupported agent kind ${ownerAgent?.kind ?? "unknown"} in session ${sourceSession.id}`,
      );
    }
    const description = input.description.trim();
    const taskDefinition = input.task.trim();
    if (description.length === 0 || taskDefinition.length === 0) {
      throw new Error("Cannot start background task with empty description or task definition.");
    }

    const contextMode = input.contextMode === "group" ? "group" : "isolated";
    const created = this.createTaskExecution({
      runType: "delegate",
      ownerAgentId: ownerAgent.id,
      conversationId: sourceSession.conversationId,
      branchId: sourceSession.branchId,
      initiatorSessionId: sourceSession.id,
      forkSourceSessionId: contextMode === "group" ? sourceSession.id : null,
      contextMode,
      description,
      inputJson: buildBackgroundTaskPayload(taskDefinition),
    });

    logger.info("starting background task run asynchronously", {
      sourceSessionId: sourceSession.id,
      ownerAgentId: ownerAgent.id,
      taskRunId: created.taskRun.id,
      executionSessionId: created.executionSession.id,
      contextMode,
    });

    void this.runCreatedTaskExecution({ created })
      .then((result) => {
        logger.info("background task run settled", {
          sourceSessionId: sourceSession.id,
          taskRunId: created.taskRun.id,
          status: result.status,
        });
      })
      .catch((error: unknown) => {
        logger.error("background task run failed before settlement", {
          sourceSessionId: sourceSession.id,
          taskRunId: created.taskRun.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return {
      accepted: true,
      taskRunId: created.taskRun.id,
    };
  }

  suppressBackgroundTaskCompletionNotice(input: { taskRunId: string }): void {
    this.suppressedBackgroundTaskCompletionNotices.add(input.taskRunId);
    const removedCount = this.removeQueuedBackgroundTaskCompletionNotice(input.taskRunId);
    if (removedCount > 0) {
      this.suppressedBackgroundTaskCompletionNotices.delete(input.taskRunId);
    }
  }

  completeTaskExecution(input: {
    taskRunId: string;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution {
    const settled = completeTaskExecution({
      db: this.deps.storage,
      taskRunId: input.taskRunId,
      ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    });
    logSettledTaskExecution("completed", settled);
    this.publishTaskRunSettledEvent("task_run_completed", settled);
    this.appendBackgroundTaskCompletionNoticeIfNeeded(settled.taskRun);
    return settled;
  }

  blockTaskExecution(input: {
    taskRunId: string;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution {
    const settled = blockTaskExecution({
      db: this.deps.storage,
      taskRunId: input.taskRunId,
      ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    });
    logSettledTaskExecution("blocked", settled);
    this.publishTaskRunSettledEvent("task_run_blocked", settled);
    this.appendBackgroundTaskCompletionNoticeIfNeeded(settled.taskRun);
    return settled;
  }

  failTaskExecution(input: {
    taskRunId: string;
    errorText?: string | null;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution {
    const settled = failTaskExecution({
      db: this.deps.storage,
      taskRunId: input.taskRunId,
      ...(input.errorText === undefined ? {} : { errorText: input.errorText }),
      ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    });
    logSettledTaskExecution("failed", settled);
    this.publishTaskRunSettledEvent("task_run_failed", settled);
    this.appendBackgroundTaskCompletionNoticeIfNeeded(settled.taskRun);
    return settled;
  }

  cancelTaskExecution(input: {
    taskRunId: string;
    cancelledBy: string;
    resultSummary?: string | null;
    finishedAt?: Date;
  }): SettledTaskExecution {
    const settled = cancelTaskExecution({
      db: this.deps.storage,
      taskRunId: input.taskRunId,
      cancelledBy: input.cancelledBy,
      ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
      ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    });
    logSettledTaskExecution("cancelled", settled);
    this.publishTaskRunSettledEvent("task_run_cancelled", settled);
    this.appendBackgroundTaskCompletionNoticeIfNeeded(settled.taskRun);
    return settled;
  }

  emitRuntimeEvent(event: AgentRuntimeEvent): void {
    this.trackSessionRunLifecycle(event);
    this.publishOutboundEvent(this.projectRuntimeEvent(event));
    const task: Promise<void> = this.handleRuntimeEvent(event)
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error("runtime event orchestration failed", {
          eventType: event.type,
          sessionId: event.sessionId,
          runId: event.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inflightRuntimeEventTasks.delete(task);
      });
    this.inflightRuntimeEventTasks.add(task);
  }

  async waitForRuntimeEventOrchestrationIdle(): Promise<void> {
    while (this.inflightRuntimeEventTasks.size > 0) {
      await Promise.allSettled([...this.inflightRuntimeEventTasks]);
    }
  }

  async handleRuntimeEvent(
    event: AgentRuntimeEvent,
  ): Promise<DelegatedApprovalDeliveryResult | null> {
    if (event.type !== "approval_requested" || event.approvalTarget !== "main_agent") {
      return null;
    }

    const approvalId = Number.parseInt(event.approvalId, 10);
    if (!Number.isFinite(approvalId)) {
      logger.warn("skipping delegated approval delivery with invalid approval id", {
        approvalId: event.approvalId,
        sessionId: event.sessionId,
        runId: event.runId,
      });
      return null;
    }

    logger.info("delivering delegated approval request to main agent", {
      approvalId,
      sourceSessionId: event.sessionId,
      sourceConversationId: event.conversationId,
      sourceBranchId: event.branchId,
      runId: event.runId,
    });

    const result = await deliverDelegatedApprovalRequest({
      db: this.deps.storage,
      ingress: this.deps.ingress,
      approvalId,
    });

    logger.info("delegated approval delivery finished", {
      approvalId,
      status: result.status,
      ...(result.targetSessionId == null ? {} : { targetSessionId: result.targetSessionId }),
      runId: event.runId,
    });

    return result;
  }

  private createTaskExecutionRunner(): TaskExecutionRunner {
    return new TaskExecutionRunner({
      ingress: this.deps.ingress,
      lifecycle: {
        blockTaskExecution: (input) => this.blockTaskExecution(input),
        completeTaskExecution: (input) => this.completeTaskExecution(input),
        failTaskExecution: (input) => this.failTaskExecution(input),
        cancelTaskExecution: (input) => this.cancelTaskExecution(input),
      },
    });
  }

  private publishTaskRunSettledEvent(
    eventType: "task_run_completed" | "task_run_blocked" | "task_run_failed" | "task_run_cancelled",
    settled: SettledTaskExecution,
  ): void {
    const taskRun = settled.taskRun;
    const event =
      eventType === "task_run_completed"
        ? {
            type: eventType,
            taskRunId: taskRun.id,
            runType: taskRun.runType,
            status: taskRun.status,
            startedAt: taskRun.startedAt,
            finishedAt: taskRun.finishedAt,
            durationMs: taskRun.durationMs,
            resultSummary: taskRun.resultSummary,
            executionSessionId: taskRun.executionSessionId,
          }
        : eventType === "task_run_blocked"
          ? {
              type: eventType,
              taskRunId: taskRun.id,
              runType: taskRun.runType,
              status: taskRun.status,
              startedAt: taskRun.startedAt,
              finishedAt: taskRun.finishedAt,
              durationMs: taskRun.durationMs,
              resultSummary: taskRun.resultSummary,
              executionSessionId: taskRun.executionSessionId,
            }
          : eventType === "task_run_failed"
            ? {
                type: eventType,
                taskRunId: taskRun.id,
                runType: taskRun.runType,
                status: taskRun.status,
                startedAt: taskRun.startedAt,
                finishedAt: taskRun.finishedAt,
                durationMs: taskRun.durationMs,
                resultSummary: taskRun.resultSummary,
                errorText: taskRun.errorText,
                executionSessionId: taskRun.executionSessionId,
              }
            : {
                type: eventType,
                taskRunId: taskRun.id,
                runType: taskRun.runType,
                status: taskRun.status,
                startedAt: taskRun.startedAt,
                finishedAt: taskRun.finishedAt,
                durationMs: taskRun.durationMs,
                resultSummary: taskRun.resultSummary,
                cancelledBy: taskRun.cancelledBy,
                executionSessionId: taskRun.executionSessionId,
              };

    this.publishOutboundEvent(
      projectTaskRunEvent({
        db: this.deps.storage,
        event,
        taskRun,
        executionSession: settled.executionSession,
      }),
    );
  }

  private publishOutboundEvent(event: OrchestratedOutboundEventEnvelope): void {
    this.deps.outboundEventBus?.publish(event);
  }

  private getCurrentSubagentRequestForDecision(
    requestId: string,
    now: Date,
  ): SubagentCreationRequest {
    const repo = new SubagentCreationRequestsRepo(this.deps.storage);
    const request = this.requireSubagentRequest(requestId);
    if (request.status !== "pending") {
      return request;
    }

    if (request.expiresAt == null || Date.parse(request.expiresAt) > now.getTime()) {
      return request;
    }

    repo.updateStatus({
      id: request.id,
      status: "expired",
      updatedAt: now,
      decidedAt: now,
    });
    return this.requireSubagentRequest(requestId);
  }

  private requireSubagentRequest(requestId: string): SubagentCreationRequest {
    const request = new SubagentCreationRequestsRepo(this.deps.storage).getById(requestId);
    if (request == null) {
      throw new Error(`Unknown SubAgent creation request ${requestId}`);
    }

    return request;
  }

  private resolveCreatedSubagentSurface(request: SubagentCreationRequest): {
    externalChatId: string | null;
    shareLink: string | null;
  } {
    if (request.status !== "created" || request.createdSubagentAgentId == null) {
      return {
        externalChatId: null,
        shareLink: null,
      };
    }

    const agent = new AgentsRepo(this.deps.storage).getById(request.createdSubagentAgentId);
    if (agent == null) {
      return {
        externalChatId: null,
        shareLink: null,
      };
    }

    const conversation = new ConversationsRepo(this.deps.storage).getById(agent.conversationId);
    return {
      externalChatId: conversation?.externalChatId ?? null,
      shareLink: null,
    };
  }

  private publishResolvedSubagentRequestEvent(input: {
    request: SubagentCreationRequest;
    externalChatId: string | null;
    shareLink: string | null;
  }): void {
    if (!isResolvedSubagentRequestStatus(input.request.status)) {
      return;
    }

    this.publishOutboundEvent(
      projectSubagentCreationEvent({
        db: this.deps.storage,
        request: input.request,
        event: {
          type: "subagent_creation_resolved",
          requestId: input.request.id,
          title: input.request.title,
          status: input.request.status,
          decidedAt: input.request.decidedAt,
          failureReason: input.request.failureReason,
          createdSubagentAgentId: input.request.createdSubagentAgentId,
          externalChatId: input.externalChatId,
          shareLink: input.shareLink,
        },
      }),
    );
  }

  private appendBackgroundTaskCompletionNoticeIfNeeded(taskRun: TaskRun): void {
    const backgroundPayload = parseBackgroundTaskPayload(taskRun.inputJson);
    if (taskRun.runType !== "delegate" || backgroundPayload == null) {
      return;
    }
    if (taskRun.initiatorSessionId == null) {
      return;
    }

    if (this.suppressedBackgroundTaskCompletionNotices.has(taskRun.id)) {
      this.suppressedBackgroundTaskCompletionNotices.delete(taskRun.id);
      logger.debug("skipped background task completion notice because it was suppressed", {
        taskRunId: taskRun.id,
      });
      return;
    }

    const sessionsRepo = new SessionsRepo(this.deps.storage);
    const sourceSession = sessionsRepo.getById(taskRun.initiatorSessionId);
    if (sourceSession == null || sourceSession.purpose !== "chat") {
      return;
    }

    const finishedAtDate =
      taskRun.finishedAt == null || Number.isNaN(Date.parse(taskRun.finishedAt))
        ? new Date()
        : new Date(taskRun.finishedAt);
    const content = renderBackgroundTaskCompletionNotice({
      taskRun,
      taskDefinition: backgroundPayload.taskDefinition,
    });

    this.enqueueBackgroundTaskCompletionNotice({
      taskRunId: taskRun.id,
      sourceSessionId: sourceSession.id,
      content,
      createdAt: finishedAtDate,
    });
    this.flushBackgroundTaskCompletionNoticesForSession({
      sessionId: sourceSession.id,
      trigger: "task_settled",
    });
  }

  private trackSessionRunLifecycle(event: AgentRuntimeEvent): void {
    if (event.type === "run_started") {
      this.activeSessionRuns.add(event.sessionId);
      return;
    }
    if (
      event.type === "run_completed" ||
      event.type === "run_failed" ||
      event.type === "run_cancelled"
    ) {
      this.activeSessionRuns.delete(event.sessionId);
      this.flushBackgroundTaskCompletionNoticesForSession({
        sessionId: event.sessionId,
        trigger: event.type,
      });
    }
  }

  private enqueueBackgroundTaskCompletionNotice(
    input: PendingBackgroundTaskCompletionNotice,
  ): void {
    const current = this.pendingBackgroundTaskCompletionNotices.get(input.sourceSessionId) ?? [];
    current.push(input);
    current.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    this.pendingBackgroundTaskCompletionNotices.set(input.sourceSessionId, current);
    logger.info("queued hidden background task completion notice", {
      taskRunId: input.taskRunId,
      sourceSessionId: input.sourceSessionId,
      pendingCount: current.length,
    });
  }

  private removeQueuedBackgroundTaskCompletionNotice(taskRunId: string): number {
    let removed = 0;
    for (const [sessionId, notices] of this.pendingBackgroundTaskCompletionNotices.entries()) {
      const next = notices.filter((notice) => notice.taskRunId !== taskRunId);
      const removedInSession = notices.length - next.length;
      if (removedInSession === 0) {
        continue;
      }
      removed += removedInSession;
      if (next.length === 0) {
        this.pendingBackgroundTaskCompletionNotices.delete(sessionId);
      } else {
        this.pendingBackgroundTaskCompletionNotices.set(sessionId, next);
      }
    }

    if (removed > 0) {
      logger.debug("removed queued background task completion notice", {
        taskRunId,
        removedCount: removed,
      });
    }

    return removed;
  }

  private flushBackgroundTaskCompletionNoticesForSession(input: {
    sessionId: string;
    trigger: string;
  }): void {
    const pending = this.pendingBackgroundTaskCompletionNotices.get(input.sessionId);
    if (pending == null || pending.length === 0) {
      return;
    }
    if (this.activeSessionRuns.has(input.sessionId)) {
      logger.debug("deferred background task completion notice flush due to active run", {
        sourceSessionId: input.sessionId,
        pendingCount: pending.length,
        trigger: input.trigger,
      });
      return;
    }

    const sourceSession = new SessionsRepo(this.deps.storage).getById(input.sessionId);
    if (sourceSession == null || sourceSession.purpose !== "chat") {
      this.pendingBackgroundTaskCompletionNotices.delete(input.sessionId);
      return;
    }

    const messagesRepo = new MessagesRepo(this.deps.storage);
    let appendedCount = 0;
    for (const notice of pending) {
      if (this.suppressedBackgroundTaskCompletionNotices.has(notice.taskRunId)) {
        this.suppressedBackgroundTaskCompletionNotices.delete(notice.taskRunId);
        continue;
      }
      messagesRepo.append({
        id: randomUUID(),
        sessionId: sourceSession.id,
        seq: messagesRepo.getNextSeq(sourceSession.id),
        role: "user",
        messageType: "background_task_completion",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({ content: notice.content }),
        createdAt: notice.createdAt,
      });
      appendedCount += 1;
    }
    this.pendingBackgroundTaskCompletionNotices.delete(input.sessionId);

    if (appendedCount > 0) {
      logger.info("flushed hidden background task completion notices", {
        sourceSessionId: sourceSession.id,
        count: appendedCount,
        trigger: input.trigger,
      });
    }
  }
}

function logSettledTaskExecution(
  status: "completed" | "blocked" | "failed" | "cancelled",
  settled: SettledTaskExecution,
): void {
  logger.info("settled task execution", {
    taskRunId: settled.taskRun.id,
    status,
    executionSessionId: settled.taskRun.executionSessionId,
    ownerAgentId: settled.taskRun.ownerAgentId,
    durationMs: settled.taskRun.durationMs,
  });
}

function summarizeCronTaskRunForKickoff(run: {
  startedAt: string;
  status: string;
  resultSummary: string | null;
  errorText: string | null;
}) {
  return {
    startedAt: run.startedAt,
    status: run.status,
    summary: run.resultSummary,
    error: run.errorText,
  };
}

function isResolvedSubagentRequestStatus(
  status: string,
): status is "created" | "denied" | "failed" | "expired" {
  return status === "created" || status === "denied" || status === "failed" || status === "expired";
}

function toResolvedApproveOutcome(
  status: string,
): "already_created" | "already_denied" | "already_failed" | "already_expired" {
  if (status === "created") {
    return "already_created";
  }
  if (status === "denied") {
    return "already_denied";
  }
  if (status === "failed") {
    return "already_failed";
  }
  if (status === "expired") {
    return "already_expired";
  }

  throw new Error(`Unsupported SubAgent request status for approve resolution: ${status}`);
}

function toResolvedDenyOutcome(
  status: string,
): "already_created" | "already_denied" | "already_failed" | "already_expired" {
  return toResolvedApproveOutcome(status);
}

function renderBackgroundTaskCompletionNotice(input: {
  taskRun: TaskRun;
  taskDefinition: string;
}): string {
  const lines = [
    '<system_event type="background_task_completion">',
    `task_run_id: ${input.taskRun.id}`,
    `status: ${input.taskRun.status}`,
  ];

  if (input.taskRun.description != null && input.taskRun.description.trim().length > 0) {
    lines.push(`description: ${input.taskRun.description.trim()}`);
  }
  if (input.taskRun.resultSummary != null && input.taskRun.resultSummary.trim().length > 0) {
    lines.push(`result_summary: ${input.taskRun.resultSummary.trim()}`);
  }
  if (input.taskRun.errorText != null && input.taskRun.errorText.trim().length > 0) {
    lines.push(`error: ${input.taskRun.errorText.trim()}`);
  }
  if (input.taskRun.cancelledBy != null && input.taskRun.cancelledBy.trim().length > 0) {
    lines.push(`cancelled_by: ${input.taskRun.cancelledBy.trim()}`);
  }
  if (input.taskRun.finishedAt != null && input.taskRun.finishedAt.trim().length > 0) {
    lines.push(`finished_at: ${input.taskRun.finishedAt}`);
  }

  lines.push("task_definition:");
  lines.push(input.taskDefinition);
  lines.push(
    "This is a system completion notice for a background task you started. Do not echo this raw block to the user.",
  );
  lines.push("</system_event>");
  return lines.join("\n");
}
