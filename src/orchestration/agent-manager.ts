/**
 * Top-level orchestration coordinator.
 *
 * AgentManager is the cross-session control plane above runtime loop execution.
 * It routes runtime events, manages delegated approvals, drives task/cron runs,
 * and publishes channel-facing outbound envelopes.
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import {
  type ProviderRegistrySource,
  resolveProviderRegistry,
} from "@/src/agent/llm/provider-registry-source.js";
import type { RunAgentLoopResult } from "@/src/agent/loop.js";
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
  projectThinkTankEvent,
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
import {
  buildDefaultThinkTankPlannedSteps,
  findThinkTankParticipantRoundStepBySlot,
  normalizeRunningThinkTankStep,
  normalizeSubmittedThinkTankSteps,
  upsertThinkTankEpisodeResultStep,
} from "@/src/orchestration/think-tank-steps.js";
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
import { ThinkTankConsultationsRepo } from "@/src/storage/repos/think-tank-consultations.repo.js";
import { ThinkTankEpisodesRepo } from "@/src/storage/repos/think-tank-episodes.repo.js";
import { ThinkTankParticipantsRepo } from "@/src/storage/repos/think-tank-participants.repo.js";
import type { SubagentCreationRequest, TaskRun } from "@/src/storage/schema/types.js";
import {
  buildBackgroundTaskPayload,
  parseBackgroundTaskPayload,
} from "@/src/tasks/background-task-payload.js";
import { TaskExecutionRunner, type TaskExecutionRunResult } from "@/src/tasks/runner.js";
import type { ThinkTankEpisodeSubmitStep } from "@/src/think-tank/episode-completion.js";
import { applyThinkTankParticipantReplyFallbackLimit } from "@/src/think-tank/reply-limits.js";
import { ThinkTankEpisodeRunner } from "@/src/think-tank/runner.js";
import {
  buildThinkTankModeratorSetupEnvelope,
  buildThinkTankParticipantConsultEnvelope,
  buildThinkTankParticipantSetupEnvelope,
} from "@/src/think-tank/session-runtime.js";
import type {
  ThinkTankCapabilities,
  ThinkTankConsultationStatusView,
  ThinkTankEpisodeResult,
  ThinkTankEpisodeStepSnapshot,
  ThinkTankEpisodeStepUpsertInput,
  ThinkTankParticipantDefinition,
  ThinkTankParticipantRoundStepHint,
  ThinkTankStructuredSummary,
} from "@/src/think-tank/types.js";

const logger = createSubsystemLogger("orchestration/agent-manager");

export interface AgentManagerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
  submitApprovalDecision(input: ApprovalResponseInput): boolean;
}

export interface AgentManagerDependencies {
  storage: StorageDb;
  ingress: AgentManagerIngress;
  outboundEventBus?: RuntimeEventBus<OrchestratedOutboundEventEnvelope>;
  models?: ProviderRegistrySource;
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

interface PendingThinkTankCompletionNotice {
  consultationId: string;
  sourceSessionId: string;
  content: string;
  createdAt: Date;
}

const THINK_TANK_RECOMMENDED_PARTICIPANT_COUNT = 2;
const THINK_TANK_MAX_PARTICIPANT_COUNT = 4;

// AgentManager is the orchestration-facing runtime entrypoint.
// It sits above session-local runtime ingress and handles cross-session
// coordination such as delegated approvals without pulling that logic into
// AgentLoop or session lanes.
export class AgentManager {
  private readonly inflightRuntimeEventTasks = new Set<Promise<void>>();
  private readonly inflightThinkTankTasks = new Set<Promise<void>>();
  private readonly suppressedBackgroundTaskCompletionNotices = new Set<string>();
  private readonly activeSessionRuns = new Set<string>();
  private readonly pendingBackgroundTaskCompletionNotices = new Map<
    string,
    PendingBackgroundTaskCompletionNotice[]
  >();
  private readonly pendingThinkTankCompletionNotices = new Map<
    string,
    PendingThinkTankCompletionNotice[]
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

  getThinkTankCapabilities(_input: { sourceSessionId: string }): ThinkTankCapabilities {
    const models = this.requireThinkTankModels();
    return {
      availableModels: models.getScenarioModelIds("thinkTankAdvisor"),
      recommendedParticipantCount: THINK_TANK_RECOMMENDED_PARTICIPANT_COUNT,
      maxParticipantCount: THINK_TANK_MAX_PARTICIPANT_COUNT,
    };
  }

  async startThinkTankConsultation(input: {
    sourceSessionId: string;
    sourceConversationId: string;
    sourceBranchId: string;
    ownerAgentId: string | null;
    moderatorModelId: string;
    topic: string;
    context: string;
    participants: ThinkTankParticipantDefinition[];
  }): Promise<{
    accepted: true;
    consultationId: string;
    status: "running";
    participants: Array<{
      id: string;
      model: string;
      title: string | null;
      continuationSessionId: string;
    }>;
  }> {
    const sessionsRepo = new SessionsRepo(this.deps.storage);
    const messagesRepo = new MessagesRepo(this.deps.storage);
    const sourceSession = sessionsRepo.getById(input.sourceSessionId);
    if (sourceSession == null) {
      throw new Error(`Cannot start think tank from unknown session ${input.sourceSessionId}`);
    }
    if (sourceSession.purpose !== "chat") {
      throw new Error(
        `Cannot start think tank from non-chat session ${sourceSession.id} (${sourceSession.purpose})`,
      );
    }
    if (sourceSession.conversationId !== input.sourceConversationId) {
      throw new Error("Think tank source conversation mismatch.");
    }
    if (sourceSession.branchId !== input.sourceBranchId) {
      throw new Error("Think tank source branch mismatch.");
    }
    if (sourceSession.ownerAgentId == null) {
      throw new Error(`Cannot start think tank from unowned session ${sourceSession.id}`);
    }

    const participantCount = input.participants.length;
    if (
      participantCount < THINK_TANK_RECOMMENDED_PARTICIPANT_COUNT ||
      participantCount > THINK_TANK_MAX_PARTICIPANT_COUNT
    ) {
      throw new Error(
        `Think tank participant count must be between ${THINK_TANK_RECOMMENDED_PARTICIPANT_COUNT} and ${THINK_TANK_MAX_PARTICIPANT_COUNT}.`,
      );
    }

    const availableModels = new Set(
      this.requireThinkTankModels().getScenarioModelIds("thinkTankAdvisor"),
    );
    for (const participant of input.participants) {
      if (!availableModels.has(participant.model)) {
        throw new Error(`Think tank participant model is not allowed: ${participant.model}`);
      }
    }

    const now = new Date();
    const consultationId = randomUUID();
    const moderatorSessionId = randomUUID();
    sessionsRepo.create({
      id: moderatorSessionId,
      conversationId: sourceSession.conversationId,
      branchId: sourceSession.branchId,
      ownerAgentId: sourceSession.ownerAgentId,
      purpose: "think_tank_moderator",
      contextMode: "isolated",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    consultationsRepo.create({
      id: consultationId,
      sourceSessionId: sourceSession.id,
      sourceConversationId: sourceSession.conversationId,
      sourceBranchId: sourceSession.branchId,
      ownerAgentId: sourceSession.ownerAgentId,
      moderatorSessionId,
      moderatorModelId: input.moderatorModelId,
      status: "running",
      topic: input.topic,
      contextText: input.context,
      createdAt: now,
      updatedAt: now,
      lastEpisodeStartedAt: now,
    });

    const participantsRepo = new ThinkTankParticipantsRepo(this.deps.storage);
    const assignedParticipants = input.participants.map((participant, index) => {
      const continuationSessionId = randomUUID();
      sessionsRepo.create({
        id: continuationSessionId,
        conversationId: sourceSession.conversationId,
        branchId: sourceSession.branchId,
        ownerAgentId: sourceSession.ownerAgentId,
        purpose: "think_tank_participant",
        contextMode: "isolated",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      participantsRepo.create({
        id: randomUUID(),
        consultationId,
        participantId: participant.id,
        title: participant.title ?? null,
        modelId: participant.model,
        personaText: participant.persona,
        continuationSessionId,
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      });

      return {
        id: participant.id,
        model: participant.model,
        title: participant.title ?? null,
        continuationSessionId,
      };
    });

    messagesRepo.append({
      id: randomUUID(),
      sessionId: moderatorSessionId,
      seq: messagesRepo.getNextSeq(moderatorSessionId),
      role: "user",
      messageType: "think_tank_consultation_setup",
      visibility: "hidden_system",
      payloadJson: JSON.stringify({
        content: buildThinkTankModeratorSetupEnvelope({
          consultationId,
          topic: input.topic,
          context: input.context,
          participants: assignedParticipants,
          participantPersonas: input.participants.map((participant) => ({
            id: participant.id,
            persona: participant.persona,
            title: participant.title ?? null,
            model: participant.model,
          })),
        }),
      }),
      createdAt: now,
    });

    for (const participant of input.participants) {
      const assigned = assignedParticipants.find((entry) => entry.id === participant.id);
      if (assigned == null) {
        throw new Error(`Think tank participant assignment disappeared: ${participant.id}`);
      }
      messagesRepo.append({
        id: randomUUID(),
        sessionId: assigned.continuationSessionId,
        seq: messagesRepo.getNextSeq(assigned.continuationSessionId),
        role: "user",
        messageType: "think_tank_participant_setup",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({
          content: buildThinkTankParticipantSetupEnvelope({
            consultationId,
            participantId: participant.id,
            title: participant.title ?? null,
            model: participant.model,
            topic: input.topic,
            context: input.context,
            persona: participant.persona,
          }),
        }),
        createdAt: now,
      });
    }

    const episodeId = randomUUID();
    new ThinkTankEpisodesRepo(this.deps.storage).create({
      id: episodeId,
      consultationId,
      sequence: 1,
      status: "running",
      promptText: input.topic,
      startedAt: now,
    });

    const consultationAnchor = {
      id: consultationId,
      sourceConversationId: sourceSession.conversationId,
      sourceBranchId: sourceSession.branchId,
      sourceSessionId: sourceSession.id,
    };
    this.publishThinkTankConsultationUpserted({
      consultationAnchor,
      consultationStatus: "running",
      topic: input.topic,
      participants: assignedParticipants.map((participant) => ({
        id: participant.id,
        title: participant.title,
        model: participant.model,
      })),
      latestSummary: null,
      firstCompleted: false,
    });
    this.publishThinkTankEpisodeStarted({
      consultationAnchor,
      episodeId,
      episodeSequence: 1,
      prompt: input.topic,
    });

    const task = this.runThinkTankEpisodeAsync({
      consultationId,
      episodeId,
    }).finally(() => {
      this.inflightThinkTankTasks.delete(task);
    });
    this.inflightThinkTankTasks.add(task);

    return {
      accepted: true,
      consultationId,
      status: "running",
      participants: assignedParticipants,
    };
  }

  continueThinkTankConsultation(input: {
    consultationId: string;
    prompt: string;
    createdAt?: Date;
  }): {
    accepted: true;
    consultationId: string;
    episodeId: string;
    episodeSequence: number;
    status: "running";
  } {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new Error("Think tank follow-up prompt cannot be empty.");
    }
    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    const episodesRepo = new ThinkTankEpisodesRepo(this.deps.storage);
    const consultation = consultationsRepo.getById(input.consultationId);
    if (consultation == null) {
      throw new Error(`Think tank consultation not found: ${input.consultationId}`);
    }
    if (
      consultation.status === "running" ||
      episodesRepo.findActiveByConsultation(consultation.id)
    ) {
      throw new Error(
        `Think tank consultation ${consultation.id} is already running. Wait for the current episode to settle before sending follow-up input.`,
      );
    }

    const participants = this.listThinkTankParticipantDisplays(consultation.id);
    const startedAt = input.createdAt ?? new Date();
    const latestEpisode = episodesRepo.findLatestByConsultation(consultation.id);
    const episodeSequence = (latestEpisode?.sequence ?? 0) + 1;
    const episodeId = randomUUID();

    episodesRepo.create({
      id: episodeId,
      consultationId: consultation.id,
      sequence: episodeSequence,
      status: "running",
      promptText: prompt,
      startedAt,
    });
    consultationsRepo.update({
      id: consultation.id,
      status: "running",
      lastEpisodeStartedAt: startedAt,
      updatedAt: startedAt,
    });

    const consultationAnchor = this.buildThinkTankConsultationAnchor(consultation);
    this.publishThinkTankConsultationUpserted({
      consultationAnchor,
      consultationStatus: "running",
      topic: consultation.topic,
      participants,
      latestSummary: parseThinkTankSummaryJson(consultation.latestSummaryJson),
      firstCompleted: consultation.firstCompletedAt != null,
    });
    this.publishThinkTankEpisodeStarted({
      consultationAnchor,
      episodeId,
      episodeSequence,
      prompt,
    });

    const task = this.runThinkTankEpisodeAsync({
      consultationId: consultation.id,
      episodeId,
    }).finally(() => {
      this.inflightThinkTankTasks.delete(task);
    });
    this.inflightThinkTankTasks.add(task);

    return {
      accepted: true,
      consultationId: consultation.id,
      episodeId,
      episodeSequence,
      status: "running",
    };
  }

  getThinkTankStatus(input: {
    sourceSessionId: string;
    consultationId: string;
  }): ThinkTankConsultationStatusView | null {
    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    const consultation = consultationsRepo.getById(input.consultationId);
    if (consultation == null || consultation.sourceSessionId !== input.sourceSessionId) {
      return null;
    }

    const participants = new ThinkTankParticipantsRepo(this.deps.storage)
      .listByConsultation(consultation.id)
      .map((participant) => ({
        id: participant.participantId,
        model: participant.modelId,
        title: participant.title,
        continuationSessionId: participant.continuationSessionId,
      }));
    const latestEpisode = new ThinkTankEpisodesRepo(this.deps.storage).findLatestByConsultation(
      consultation.id,
    );

    return {
      consultationId: consultation.id,
      topic: consultation.topic,
      status: consultation.status as "running" | "idle",
      latestEpisodeStatus:
        latestEpisode == null
          ? null
          : (latestEpisode.status as ThinkTankConsultationStatusView["latestEpisodeStatus"]),
      participants,
      latestSummary: parseThinkTankSummaryJson(consultation.latestSummaryJson),
      updatedAt: consultation.updatedAt,
    };
  }

  async consultThinkTankParticipant(input: {
    moderatorSessionId: string;
    participantId: string;
    prompt: string;
    step?: ThinkTankParticipantRoundStepHint;
  }): Promise<{
    participantId: string;
    title: string | null;
    model: string;
    continuationSessionId: string;
    reply: string;
  }> {
    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    const consultation = consultationsRepo.getByModeratorSessionId(input.moderatorSessionId);
    if (consultation == null) {
      throw new Error(
        `Cannot consult think tank participant from unknown moderator session ${input.moderatorSessionId}`,
      );
    }
    const runningEpisode = this.requireRunningThinkTankEpisodeState({
      moderatorSessionId: input.moderatorSessionId,
      consultation,
    });

    const participant = new ThinkTankParticipantsRepo(this.deps.storage).getByParticipantId({
      consultationId: consultation.id,
      participantId: input.participantId,
    });
    if (participant == null) {
      throw new Error(
        `Think tank participant ${input.participantId} does not exist in consultation ${consultation.id}`,
      );
    }

    const started = await this.deps.ingress.submitMessage({
      sessionId: participant.continuationSessionId,
      scenario: "chat",
      modelIdOverride: participant.modelId,
      content: buildThinkTankParticipantConsultEnvelope({
        prompt: input.prompt,
      }),
      messageType: "think_tank_participant_consult",
      visibility: "hidden_system",
    });

    if (started.status !== "started") {
      throw new Error(
        `Think tank participant session ${participant.continuationSessionId} was already active.`,
      );
    }

    const reply = extractLatestAssistantTextFromRun(started.run);
    if (reply == null || reply.trim().length === 0) {
      throw new Error(
        `Think tank participant ${participant.participantId} completed without assistant text.`,
      );
    }
    const limitedReply = applyThinkTankParticipantReplyFallbackLimit({ reply: reply.trim() });
    if (limitedReply.truncated) {
      logger.warn("truncated think tank participant reply at fallback limit", {
        consultationId: consultation.id,
        participantId: participant.participantId,
        continuationSessionId: participant.continuationSessionId,
        originalCharCount: limitedReply.originalCharCount,
        maxChars: limitedReply.maxChars,
      });
    }
    const normalizedReply = limitedReply.reply;
    const existingRoundStep = findThinkTankParticipantRoundStepBySlot({
      steps: runningEpisode.result.steps,
      ...(input.step?.key === undefined ? {} : { key: input.step.key }),
      ...(input.step?.roundIndex === undefined ? {} : { roundIndex: input.step.roundIndex }),
      ...(input.step?.order === undefined ? {} : { order: input.step.order }),
    });
    const mergedParticipantIds = new Set(
      existingRoundStep?.participantRound?.entries.map((entry) => entry.participantId) ?? [],
    );
    mergedParticipantIds.add(participant.participantId);
    const roundStatus =
      mergedParticipantIds.size >= runningEpisode.participants.length ? "completed" : "pending";

    this.persistRunningThinkTankEpisodeStep({
      consultation: runningEpisode.consultation,
      episode: runningEpisode.episode,
      participants: runningEpisode.participants,
      participantIndex: runningEpisode.participantIndex,
      currentResult: runningEpisode.result,
      stepInput: {
        kind: "participant_round",
        status: roundStatus,
        ...(input.step?.key === undefined ? {} : { key: input.step.key }),
        ...(input.step?.title === undefined ? {} : { title: input.step.title }),
        ...(input.step?.order === undefined ? {} : { order: input.step.order }),
        ...(input.step?.roundIndex === undefined ? {} : { roundIndex: input.step.roundIndex }),
        participantEntries: [
          {
            participantId: participant.participantId,
            content: normalizedReply,
          },
        ],
      },
    });

    return {
      participantId: participant.participantId,
      title: participant.title,
      model: participant.modelId,
      continuationSessionId: participant.continuationSessionId,
      reply: normalizedReply,
    };
  }

  upsertThinkTankEpisodeStep(input: {
    moderatorSessionId: string;
    step: ThinkTankEpisodeStepUpsertInput;
  }): {
    step: ThinkTankEpisodeStepSnapshot;
  } {
    const runningEpisode = this.requireRunningThinkTankEpisodeState({
      moderatorSessionId: input.moderatorSessionId,
    });
    const step = this.persistRunningThinkTankEpisodeStep({
      consultation: runningEpisode.consultation,
      episode: runningEpisode.episode,
      participants: runningEpisode.participants,
      participantIndex: runningEpisode.participantIndex,
      currentResult: runningEpisode.result,
      stepInput: input.step,
    });

    return {
      step,
    };
  }

  suppressBackgroundTaskCompletionNotice(input: { taskRunId: string }): void {
    this.suppressedBackgroundTaskCompletionNotices.add(input.taskRunId);
    const removedCount = this.removeQueuedBackgroundTaskCompletionNotice(input.taskRunId);
    if (removedCount > 0) {
      this.suppressedBackgroundTaskCompletionNotices.delete(input.taskRunId);
    }
  }

  private async runThinkTankEpisodeAsync(input: {
    consultationId: string;
    episodeId: string;
  }): Promise<void> {
    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    const episodesRepo = new ThinkTankEpisodesRepo(this.deps.storage);
    const consultation = consultationsRepo.getById(input.consultationId);
    const episode = episodesRepo.getById(input.episodeId);
    if (consultation == null || episode == null) {
      logger.warn("skipping think tank episode run because state is missing", {
        consultationId: input.consultationId,
        episodeId: input.episodeId,
      });
      return;
    }

    logger.info("starting think tank episode asynchronously", {
      consultationId: consultation.id,
      episodeId: episode.id,
      episodeSequence: episode.sequence,
      moderatorSessionId: consultation.moderatorSessionId,
      moderatorModelId: consultation.moderatorModelId,
    });

    const runner = new ThinkTankEpisodeRunner({
      ingress: this.deps.ingress,
    });
    const latestConclusion = parseThinkTankSummaryJson(
      consultation.latestSummaryJson,
    )?.currentConclusion;
    const result = await runner.runEpisode({
      moderatorSessionId: consultation.moderatorSessionId,
      moderatorModelId: consultation.moderatorModelId,
      consultationId: consultation.id,
      episodeId: episode.id,
      episodeSequence: episode.sequence,
      episodePrompt: episode.promptText,
      ...(latestConclusion == null ? {} : { latestConclusion }),
    });

    if (result.status === "completed") {
      this.completeThinkTankEpisode({
        consultation,
        episode,
        completion: result.completion,
        finishedAt: new Date(),
      });
      return;
    }

    this.failThinkTankEpisode({
      consultation,
      episode,
      status: result.status,
      errorMessage: result.errorMessage,
      finishedAt: new Date(),
    });
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

  async waitForThinkTankIdle(): Promise<void> {
    while (this.inflightThinkTankTasks.size > 0) {
      await Promise.allSettled([...this.inflightThinkTankTasks]);
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

  private completeThinkTankEpisode(input: {
    consultation: NonNullable<ReturnType<ThinkTankConsultationsRepo["getById"]>>;
    episode: NonNullable<ReturnType<ThinkTankEpisodesRepo["getById"]>>;
    completion: { summary: ThinkTankStructuredSummary; steps: ThinkTankEpisodeSubmitStep[] };
    finishedAt: Date;
  }): void {
    const participants = new ThinkTankParticipantsRepo(this.deps.storage).listByConsultation(
      input.consultation.id,
    );
    const participantIndex = new Map(
      participants.map((participant) => [participant.participantId, participant]),
    );
    const normalizedSteps = normalizeSubmittedThinkTankSteps({
      steps: input.completion.steps,
      participantIndex,
    });
    const result: ThinkTankEpisodeResult = {
      steps: normalizedSteps,
      latestSummary: input.completion.summary,
    };

    new ThinkTankEpisodesRepo(this.deps.storage).update({
      id: input.episode.id,
      status: "completed",
      result,
      errorText: null,
      finishedAt: input.finishedAt,
    });

    const firstCompletedAt =
      input.consultation.firstCompletedAt == null ? input.finishedAt : undefined;
    new ThinkTankConsultationsRepo(this.deps.storage).update({
      id: input.consultation.id,
      status: "idle",
      latestSummary: input.completion.summary,
      ...(firstCompletedAt === undefined ? {} : { firstCompletedAt }),
      lastEpisodeFinishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    });

    const consultationAnchor = {
      id: input.consultation.id,
      sourceConversationId: input.consultation.sourceConversationId,
      sourceBranchId: input.consultation.sourceBranchId,
      sourceSessionId: input.consultation.sourceSessionId,
    };

    for (const step of normalizedSteps) {
      this.publishOutboundEvent(
        projectThinkTankEvent({
          db: this.deps.storage,
          consultation: consultationAnchor,
          event: {
            type: "episode_step_upserted",
            episodeId: input.episode.id,
            episodeSequence: input.episode.sequence,
            step,
          },
        }),
      );
    }

    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: consultationAnchor,
        event: {
          type: "episode_settled",
          episodeId: input.episode.id,
          episodeSequence: input.episode.sequence,
          status: "completed",
          latestSummary: input.completion.summary,
        },
      }),
    );

    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: consultationAnchor,
        event: {
          type: "consultation_upserted",
          status: "idle",
          topic: input.consultation.topic,
          participants: participants.map((participant) => ({
            id: participant.participantId,
            title: participant.title,
            model: participant.modelId,
          })),
          latestSummary: input.completion.summary,
          firstCompleted: true,
        },
      }),
    );

    if (input.consultation.firstCompletedAt == null) {
      this.appendThinkTankCompletionNoticeIfNeeded({
        consultationId: input.consultation.id,
      });
    }
  }

  private failThinkTankEpisode(input: {
    consultation: NonNullable<ReturnType<ThinkTankConsultationsRepo["getById"]>>;
    episode: NonNullable<ReturnType<ThinkTankEpisodesRepo["getById"]>>;
    status: "failed" | "cancelled";
    errorMessage: string;
    finishedAt: Date;
  }): void {
    const result: ThinkTankEpisodeResult = {
      steps: [
        {
          key: "error",
          kind: "error",
          title: "Episode Error",
          order: 999,
          status: "failed",
          error: {
            message: input.errorMessage,
          },
        },
      ],
      latestSummary: null,
    };
    const errorStep = result.steps[0];
    if (errorStep == null) {
      throw new Error("Think tank failure result is missing its error step.");
    }

    new ThinkTankEpisodesRepo(this.deps.storage).update({
      id: input.episode.id,
      status: input.status,
      result,
      errorText: input.errorMessage,
      finishedAt: input.finishedAt,
    });
    new ThinkTankConsultationsRepo(this.deps.storage).update({
      id: input.consultation.id,
      status: "idle",
      lastEpisodeFinishedAt: input.finishedAt,
      updatedAt: input.finishedAt,
    });

    const participants = new ThinkTankParticipantsRepo(this.deps.storage).listByConsultation(
      input.consultation.id,
    );
    const consultationAnchor = {
      id: input.consultation.id,
      sourceConversationId: input.consultation.sourceConversationId,
      sourceBranchId: input.consultation.sourceBranchId,
      sourceSessionId: input.consultation.sourceSessionId,
    };

    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: consultationAnchor,
        event: {
          type: "episode_step_upserted",
          episodeId: input.episode.id,
          episodeSequence: input.episode.sequence,
          step: errorStep,
        },
      }),
    );

    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: consultationAnchor,
        event: {
          type: "episode_settled",
          episodeId: input.episode.id,
          episodeSequence: input.episode.sequence,
          status: input.status,
          latestSummary: null,
        },
      }),
    );

    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: consultationAnchor,
        event: {
          type: "consultation_upserted",
          status: "idle",
          topic: input.consultation.topic,
          participants: participants.map((participant) => ({
            id: participant.participantId,
            title: participant.title,
            model: participant.modelId,
          })),
          latestSummary: parseThinkTankSummaryJson(input.consultation.latestSummaryJson),
          firstCompleted: input.consultation.firstCompletedAt != null,
        },
      }),
    );
  }

  private buildThinkTankConsultationAnchor(
    consultation: Pick<
      NonNullable<ReturnType<ThinkTankConsultationsRepo["getById"]>>,
      "id" | "sourceConversationId" | "sourceBranchId" | "sourceSessionId"
    >,
  ) {
    return {
      id: consultation.id,
      sourceConversationId: consultation.sourceConversationId,
      sourceBranchId: consultation.sourceBranchId,
      sourceSessionId: consultation.sourceSessionId,
    };
  }

  private listThinkTankParticipantDisplays(consultationId: string): Array<{
    id: string;
    title: string | null;
    model: string;
  }> {
    return new ThinkTankParticipantsRepo(this.deps.storage)
      .listByConsultation(consultationId)
      .map((participant) => ({
        id: participant.participantId,
        title: participant.title,
        model: participant.modelId,
      }));
  }

  private requireRunningThinkTankEpisodeState(input: {
    moderatorSessionId: string;
    consultation?: NonNullable<ReturnType<ThinkTankConsultationsRepo["getByModeratorSessionId"]>>;
  }): {
    consultation: NonNullable<ReturnType<ThinkTankConsultationsRepo["getByModeratorSessionId"]>>;
    episode: NonNullable<ReturnType<ThinkTankEpisodesRepo["findActiveByConsultation"]>>;
    participants: Array<{
      participantId: string;
      title: string | null;
      modelId: string;
    }>;
    participantIndex: Map<
      string,
      {
        participantId: string;
        title: string | null;
        modelId: string;
      }
    >;
    result: ThinkTankEpisodeResult;
  } {
    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    const consultation =
      input.consultation ?? consultationsRepo.getByModeratorSessionId(input.moderatorSessionId);
    if (consultation == null) {
      throw new Error(
        `Cannot resolve think tank consultation for moderator session ${input.moderatorSessionId}`,
      );
    }

    const episodesRepo = new ThinkTankEpisodesRepo(this.deps.storage);
    const episode = episodesRepo.findActiveByConsultation(consultation.id);
    if (episode == null) {
      throw new Error(`Think tank consultation ${consultation.id} has no active episode.`);
    }

    const participants = new ThinkTankParticipantsRepo(this.deps.storage)
      .listByConsultation(consultation.id)
      .map((participant) => ({
        participantId: participant.participantId,
        title: participant.title,
        modelId: participant.modelId,
      }));
    const participantIndex = new Map(
      participants.map((participant) => [participant.participantId, participant]),
    );

    return {
      consultation,
      episode,
      participants,
      participantIndex,
      result: parseThinkTankEpisodeResultJson(episode.resultJson) ?? {
        steps: [],
        latestSummary: null,
      },
    };
  }

  private persistRunningThinkTankEpisodeStep(input: {
    consultation: Pick<
      NonNullable<ReturnType<ThinkTankConsultationsRepo["getById"]>>,
      "id" | "sourceConversationId" | "sourceBranchId" | "sourceSessionId"
    >;
    episode: Pick<NonNullable<ReturnType<ThinkTankEpisodesRepo["getById"]>>, "id" | "sequence">;
    participants: Array<{
      participantId: string;
      title: string | null;
      modelId: string;
    }>;
    participantIndex: Map<
      string,
      {
        participantId: string;
        title: string | null;
        modelId: string;
      }
    >;
    currentResult: ThinkTankEpisodeResult;
    stepInput: ThinkTankEpisodeStepUpsertInput;
  }): ThinkTankEpisodeStepSnapshot {
    const step = normalizeRunningThinkTankStep({
      step: input.stepInput,
      existingSteps: input.currentResult.steps,
      participants: input.participants,
      participantIndex: input.participantIndex,
    });
    const nextResult = upsertThinkTankEpisodeResultStep({
      current: input.currentResult,
      step,
    });

    new ThinkTankEpisodesRepo(this.deps.storage).update({
      id: input.episode.id,
      result: nextResult,
    });

    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: this.buildThinkTankConsultationAnchor(input.consultation),
        event: {
          type: "episode_step_upserted",
          episodeId: input.episode.id,
          episodeSequence: input.episode.sequence,
          step,
        },
      }),
    );

    return step;
  }

  private publishThinkTankConsultationUpserted(input: {
    consultationAnchor: {
      id: string;
      sourceConversationId: string;
      sourceBranchId: string;
      sourceSessionId: string;
    };
    consultationStatus: "running" | "idle";
    topic: string;
    participants: Array<{
      id: string;
      title: string | null;
      model: string;
    }>;
    latestSummary: ThinkTankStructuredSummary | null;
    firstCompleted: boolean;
  }): void {
    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: input.consultationAnchor,
        event: {
          type: "consultation_upserted",
          status: input.consultationStatus,
          topic: input.topic,
          participants: input.participants,
          latestSummary: input.latestSummary,
          firstCompleted: input.firstCompleted,
        },
      }),
    );
  }

  private publishThinkTankEpisodeStarted(input: {
    consultationAnchor: {
      id: string;
      sourceConversationId: string;
      sourceBranchId: string;
      sourceSessionId: string;
    };
    episodeId: string;
    episodeSequence: number;
    prompt: string;
  }): void {
    this.publishOutboundEvent(
      projectThinkTankEvent({
        db: this.deps.storage,
        consultation: input.consultationAnchor,
        event: {
          type: "episode_started",
          episodeId: input.episodeId,
          episodeSequence: input.episodeSequence,
          prompt: input.prompt,
          plannedSteps: buildDefaultThinkTankPlannedSteps(),
        },
      }),
    );
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

  private requireThinkTankModels() {
    if (this.deps.models == null) {
      throw new Error("Think tank model registry is not configured.");
    }

    return resolveProviderRegistry(this.deps.models);
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
      this.flushThinkTankCompletionNoticesForSession({
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

  private appendThinkTankCompletionNoticeIfNeeded(input: { consultationId: string }): void {
    const consultationsRepo = new ThinkTankConsultationsRepo(this.deps.storage);
    const consultation = consultationsRepo.getById(input.consultationId);
    if (consultation == null) {
      return;
    }
    if (consultation.firstCompletedAt == null || consultation.firstCompletionNoticeAt != null) {
      return;
    }

    const sourceSession = new SessionsRepo(this.deps.storage).getById(consultation.sourceSessionId);
    if (sourceSession == null || sourceSession.purpose !== "chat") {
      return;
    }

    const participants = new ThinkTankParticipantsRepo(this.deps.storage).listByConsultation(
      consultation.id,
    );
    const latestSummary = parseThinkTankSummaryJson(consultation.latestSummaryJson);
    const createdAt = new Date(consultation.firstCompletedAt);
    const content = renderThinkTankCompletionNotice({
      topic: consultation.topic,
      participants: participants.map((participant) => ({
        title: participant.title,
        model: participant.modelId,
      })),
      latestSummary,
    });

    const pending = this.pendingThinkTankCompletionNotices.get(sourceSession.id) ?? [];
    pending.push({
      consultationId: consultation.id,
      sourceSessionId: sourceSession.id,
      content,
      createdAt,
    });
    pending.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    this.pendingThinkTankCompletionNotices.set(sourceSession.id, pending);
    consultationsRepo.update({
      id: consultation.id,
      firstCompletionNoticeAt: createdAt,
      updatedAt: createdAt,
    });
    logger.info("queued hidden think tank completion notice", {
      consultationId: consultation.id,
      sourceSessionId: sourceSession.id,
      pendingCount: pending.length,
    });
    this.flushThinkTankCompletionNoticesForSession({
      sessionId: sourceSession.id,
      trigger: "think_tank_episode_completed",
    });
  }

  private flushThinkTankCompletionNoticesForSession(input: {
    sessionId: string;
    trigger: string;
  }): void {
    const pending = this.pendingThinkTankCompletionNotices.get(input.sessionId);
    if (pending == null || pending.length === 0) {
      return;
    }
    if (this.activeSessionRuns.has(input.sessionId)) {
      logger.debug("deferred think tank completion notice flush due to active run", {
        sourceSessionId: input.sessionId,
        pendingCount: pending.length,
        trigger: input.trigger,
      });
      return;
    }

    const sourceSession = new SessionsRepo(this.deps.storage).getById(input.sessionId);
    if (sourceSession == null || sourceSession.purpose !== "chat") {
      this.pendingThinkTankCompletionNotices.delete(input.sessionId);
      return;
    }

    const messagesRepo = new MessagesRepo(this.deps.storage);
    let appendedCount = 0;
    for (const notice of pending) {
      messagesRepo.append({
        id: randomUUID(),
        sessionId: sourceSession.id,
        seq: messagesRepo.getNextSeq(sourceSession.id),
        role: "user",
        messageType: "think_tank_completion",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({ content: notice.content }),
        createdAt: notice.createdAt,
      });
      appendedCount += 1;
    }
    this.pendingThinkTankCompletionNotices.delete(input.sessionId);

    if (appendedCount > 0) {
      logger.info("flushed hidden think tank completion notices", {
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

function parseThinkTankSummaryJson(raw: string | null): ThinkTankStructuredSummary | null {
  if (raw == null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThinkTankStructuredSummary>;
    if (
      !Array.isArray(parsed.agreements) ||
      !Array.isArray(parsed.keyDifferences) ||
      !Array.isArray(parsed.openQuestions) ||
      typeof parsed.currentConclusion !== "string"
    ) {
      return null;
    }
    if (
      !parsed.agreements.every((item) => typeof item === "string") ||
      !parsed.keyDifferences.every((item) => typeof item === "string") ||
      !parsed.openQuestions.every((item) => typeof item === "string")
    ) {
      return null;
    }

    return {
      agreements: parsed.agreements,
      keyDifferences: parsed.keyDifferences,
      currentConclusion: parsed.currentConclusion,
      openQuestions: parsed.openQuestions,
    };
  } catch {
    return null;
  }
}

function parseThinkTankEpisodeResultJson(raw: string | null): ThinkTankEpisodeResult | null {
  if (raw == null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThinkTankEpisodeResult>;
    if (!Array.isArray(parsed.steps)) {
      return null;
    }
    return {
      steps: parsed.steps
        .filter(
          (step): step is ThinkTankEpisodeStepSnapshot =>
            typeof step === "object" && step != null && typeof step.key === "string",
        )
        .sort((left, right) => left.order - right.order),
      latestSummary:
        parsed.latestSummary == null
          ? null
          : parseThinkTankSummaryJson(JSON.stringify(parsed.latestSummary)),
    };
  } catch {
    return null;
  }
}

function extractLatestAssistantTextFromRun(
  run:
    | RunAgentLoopResult
    | {
        events: AgentRuntimeEvent[];
      },
): string | null {
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index];
    if (event?.type === "assistant_message_completed") {
      return event.text.trim().length > 0 ? event.text.trim() : null;
    }
  }
  return null;
}

function renderThinkTankCompletionNotice(input: {
  topic: string;
  participants: Array<{
    title: string | null;
    model: string;
  }>;
  latestSummary: ThinkTankStructuredSummary | null;
}): string {
  const lines = [
    "This is a system completion notice for a think tank consultation you started. Do not echo this raw block to the user.",
    "",
    `<think_tank_completion topic="${escapeXml(input.topic)}">`,
    "  <participants>",
  ];
  for (const participant of input.participants) {
    const label =
      participant.title == null || participant.title.trim().length === 0
        ? participant.model
        : `${participant.title} (${participant.model})`;
    lines.push(`    <participant>${escapeXml(label)}</participant>`);
  }
  lines.push("  </participants>");
  if (input.latestSummary != null) {
    lines.push("  <current_conclusion>");
    lines.push(`    ${escapeXml(input.latestSummary.currentConclusion)}`);
    lines.push("  </current_conclusion>");
  }
  lines.push("</think_tank_completion>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
