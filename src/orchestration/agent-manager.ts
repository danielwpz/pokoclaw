/**
 * Top-level orchestration coordinator.
 *
 * AgentManager is the cross-session control plane above runtime loop execution.
 * It routes runtime events, manages delegated approvals, drives task/cron runs,
 * and publishes channel-facing outbound envelopes.
 */
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
  type SubmittedSubagentCreationRequest,
} from "@/src/orchestration/subagents.js";
import {
  type CreatedTaskExecution,
  type CreateTaskExecutionInput,
  createTaskExecution,
} from "@/src/orchestration/task-run-factory.js";
import {
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
import { SubagentCreationRequestsRepo } from "@/src/storage/repos/subagent-creation-requests.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { SubagentCreationRequest } from "@/src/storage/schema/types.js";
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

// AgentManager is the orchestration-facing runtime entrypoint.
// It sits above session-local runtime ingress and handles cross-session
// coordination such as delegated approvals without pulling that logic into
// AgentLoop or session lanes.
export class AgentManager {
  constructor(private readonly deps: AgentManagerDependencies) {}

  submitUserMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
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

    const created = createTaskExecution({
      db: this.deps.storage,
      params,
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

  submitSubagentCreationRequest(params: CreateSubagentInput): SubmittedSubagentCreationRequest {
    const manager = new SubagentManager({
      storage: this.deps.storage,
      ingress: this.deps.ingress,
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
    const cronJob = cronJobsRepo.getById(input.cronJobId);
    if (cronJob == null) {
      throw new Error(`Cannot create task execution for unknown cron job ${input.cronJobId}`);
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

    const created = this.createTaskExecution({
      runType: "cron",
      ownerAgentId: cronJob.ownerAgentId,
      conversationId: cronJob.targetConversationId,
      branchId: cronJob.targetBranchId,
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
    return settled;
  }

  emitRuntimeEvent(event: AgentRuntimeEvent): void {
    this.publishOutboundEvent(this.projectRuntimeEvent(event));
    void this.handleRuntimeEvent(event).catch((error: unknown) => {
      logger.error("runtime event orchestration failed", {
        eventType: event.type,
        sessionId: event.sessionId,
        runId: event.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
        completeTaskExecution: (input) => this.completeTaskExecution(input),
        failTaskExecution: (input) => this.failTaskExecution(input),
        cancelTaskExecution: (input) => this.cancelTaskExecution(input),
      },
    });
  }

  private publishTaskRunSettledEvent(
    eventType: "task_run_completed" | "task_run_failed" | "task_run_cancelled",
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
}

function logSettledTaskExecution(
  status: "completed" | "failed" | "cancelled",
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
