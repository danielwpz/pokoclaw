import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import {
  type DelegatedApprovalDeliveryResult,
  deliverDelegatedApprovalRequest,
} from "@/src/orchestration/delegated-approval.js";
import {
  type OrchestratedRuntimeEventEnvelope,
  projectRuntimeEvent,
} from "@/src/orchestration/outbound-events.js";
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
import { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";

const logger = createSubsystemLogger("orchestration/agent-manager");

export interface AgentManagerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
  submitApprovalDecision(input: ApprovalResponseInput): boolean;
}

export interface AgentManagerDependencies {
  storage: StorageDb;
  ingress: AgentManagerIngress;
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

    return created;
  }

  createCronTaskExecutionFromJob(input: {
    cronJobId: string;
    createdAt?: Date;
    attempt?: number;
  }): CreatedTaskExecution {
    const cronJobsRepo = new CronJobsRepo(this.deps.storage);
    const cronJob = cronJobsRepo.getById(input.cronJobId);
    if (cronJob == null) {
      throw new Error(`Cannot create task execution for unknown cron job ${input.cronJobId}`);
    }

    const created = this.createTaskExecution({
      runType: "cron",
      ownerAgentId: cronJob.ownerAgentId,
      conversationId: cronJob.targetConversationId,
      branchId: cronJob.targetBranchId,
      cronJobId: cronJob.id,
      contextMode: cronJob.contextMode,
      attempt: input.attempt,
      inputJson: cronJob.payloadJson,
      createdAt: input.createdAt,
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
    return settled;
  }

  emitRuntimeEvent(event: AgentRuntimeEvent): void {
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
