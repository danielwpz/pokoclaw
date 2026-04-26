/**
 * AgentLoop is the single-session execution engine.
 *
 * It runs one model "run" at a time for a session: model turn, tool calls,
 * approval waits/retries, compaction hooks, and runtime event emission.
 * Cross-session orchestration (task routing, channel rendering, etc.) is out of scope.
 */
import { randomUUID } from "node:crypto";
import {
  type AgentBootstrapResolver,
  FilesystemAgentBootstrapResolver,
} from "@/src/agent/bootstrap.js";
import {
  AgentCompactionService,
  type CompactionDecision,
  type CompactionModelRunner,
  decideCompaction,
  estimateSessionContextTokens,
} from "@/src/agent/compaction.js";
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventInput,
  AgentToolCall,
} from "@/src/agent/events.js";
import { isAgentLlmError } from "@/src/agent/llm/errors.js";
import type {
  AgentAssistantContentBlock,
  AgentAssistantPayload,
  AgentToolResultPayload,
  AgentUserPayload,
  AgentUserRuntimeImagePayload,
} from "@/src/agent/llm/messages.js";
import type { ModelScenario, ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import {
  type ProviderRegistrySource,
  resolveProviderRegistry,
} from "@/src/agent/llm/provider-registry-source.js";
import { type AgentMemoryResolver, FilesystemAgentMemoryResolver } from "@/src/agent/memory.js";
import type { AgentSessionService } from "@/src/agent/session.js";
import { assertToolAllowedForSession } from "@/src/agent/session-policy.js";
import {
  type AgentSkillsResolver,
  FilesystemAgentSkillsResolver,
  filterReadableSkillCatalogSnapshot,
  filterSkillCatalogSnapshot,
} from "@/src/agent/skills.js";
import { buildAgentSystemPrompt } from "@/src/agent/system-prompt.js";
import { requestToolApproval } from "@/src/agent/tool-approval.js";
import {
  DEFAULT_RUNTIME_APPROVAL_GRANT_TTL_MS,
  DEFAULT_RUNTIME_APPROVAL_TIMEOUT_MS,
  DEFAULT_RUNTIME_MAX_TURNS,
} from "@/src/config/defaults.js";
import type { CompactionConfig, RuntimeConfig, SecurityConfig } from "@/src/config/schema.js";
import { SessionApprovalFlowRegistry } from "@/src/runtime/approval-flow.js";
import {
  type ApprovalResponseInput,
  type ApprovalWaitOutcome,
  SessionApprovalWaitRegistry,
} from "@/src/runtime/approval-waits.js";
import type { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import type { RuntimeControlService } from "@/src/runtime/control.js";
import { SessionSteerQueueRegistry, type SteerInput } from "@/src/runtime/steer-queue.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import type { PermissionRequest } from "@/src/security/scope.js";
import { SecurityService } from "@/src/security/service.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { buildSubagentWorkspaceDir, POKOCLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import { resolveLocalCalendarContext } from "@/src/shared/time.js";
import {
  APPROVAL_DENIED_USER_INTERVENTION_CODE,
  TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE,
} from "@/src/shared/tool-result-codes.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { HarnessEventsRepo } from "@/src/storage/repos/harness-events.repo.js";
import type { MessagesRepo, MessageUsage } from "@/src/storage/repos/messages.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { ApprovalRecord, Message, Session } from "@/src/storage/schema/types.js";
import {
  buildToolFailureContent,
  isToolApprovalRequired,
  isToolFailure,
  normalizeToolFailure,
} from "@/src/tools/core/errors.js";
import type { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  type ToolExecutionApprovalState,
  type ToolExecutionContext,
  type ToolResult,
  type ToolRuntimeControl,
  textToolResult,
} from "@/src/tools/core/types.js";
import {
  isPermissionDeniedDetails,
  renderPermissionRequestResultBlock,
  renderPermissionRetryDivider,
  renderPermissionRetryNewBoundaryNote,
} from "@/src/tools/helpers/permission-block.js";

const logger = createSubsystemLogger("agent-loop");
const ASSISTANT_RESPONSE_LOG_PREVIEW_MAX_LENGTH = 144;
const ASSISTANT_REASONING_LOG_PREVIEW_MAX_LENGTH = 144;
const EMPTY_OUTPUT_LLM_RETRY_LIMIT = 1;
const UNKNOWN_ASSISTANT_ERROR_USAGE: MessageUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};
const APPROVAL_INTERVENTION_REASON_TEXT =
  "Automatically denied because the user sent a new message to redirect the run.";

// AgentLoop is the execution core for a single session run.
// It owns model turns, tool execution, compaction hooks, and the runtime-side
// approval pause/resume control flow. It does not own transport ingress or
// cross-session coordination; that belongs to src/runtime/*.
export interface AgentModelTurnResult {
  provider: string;
  model: string;
  modelApi: string;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  content: AgentAssistantContentBlock[];
  usage: MessageUsage;
  errorMessage?: string;
}

export interface AgentModelTurnInput {
  sessionId: string;
  conversationId: string;
  scenario: ModelScenario;
  sessionPurpose?: string;
  agentKind?: string | null;
  model: ResolvedModel;
  systemPrompt?: string;
  compactSummary: string | null;
  messages: Message[];
  resolveRuntimeImages?: (message: Message) => AgentUserRuntimeImagePayload[];
  signal: AbortSignal;
  onTextDelta?: (delta: { delta: string; accumulatedText: string }) => void;
  onThinkingDelta?: (delta: { delta: string }) => void;
}

export interface AgentModelRunner {
  runTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult>;
}

export interface RunAgentLoopInput {
  sessionId: string;
  scenario: ModelScenario;
  initialRuntimeImagesByMessageId?: Record<string, AgentUserRuntimeImagePayload[]>;
  maxTurns?: number;
  afterToolResultHook?: AgentLoopAfterToolResultHook;
}

export interface AgentLoopStopSignal {
  reason: string;
  payload?: unknown;
}

export interface RunAgentLoopResult {
  runId: string;
  sessionId: string;
  scenario: ModelScenario;
  modelId: string;
  appendedMessageIds: string[];
  toolExecutions: number;
  compaction: CompactionDecision;
  events: AgentRuntimeEvent[];
  stopSignal: AgentLoopStopSignal | null;
}

export type AgentLoopAfterToolResultDecision =
  | {
      kind: "continue";
    }
  | {
      kind: "stop_run";
      reason: string;
      payload?: unknown;
    };

export interface AgentLoopAfterToolResultHook {
  afterToolResult(input: {
    run: RunAgentLoopInput;
    sessionPurpose: string;
    ownerAgentId?: string | null;
    agentKind?: string | null;
    runId: string;
    turn: number;
    toolCall: AgentToolCall;
    result: ToolResult;
  }): AgentLoopAfterToolResultDecision | null | Promise<AgentLoopAfterToolResultDecision | null>;
}

export interface AgentLoopDependencies {
  sessions: AgentSessionService;
  messages: MessagesRepo;
  models: ProviderRegistry | ProviderRegistrySource;
  tools: ToolRegistry;
  skillsResolver?: AgentSkillsResolver;
  bootstrapResolver?: AgentBootstrapResolver;
  memoryResolver?: AgentMemoryResolver;
  cancel: SessionRunAbortRegistry;
  modelRunner: AgentModelRunner;
  storage: StorageDb;
  securityConfig: SecurityConfig;
  compaction: CompactionConfig;
  runtime?: RuntimeConfig;
  approvalTimeoutMs?: number;
  approvalGrantTtlMs?: number;
  approvalFlow?: SessionApprovalFlowRegistry;
  runtimeControl?: Omit<ToolRuntimeControl, "submitApprovalDecision">;
  control?: RuntimeControlService;
  emitEvent?: (event: AgentRuntimeEvent) => void;
}

interface ExecutedToolCall {
  result: ToolResult;
  isError: boolean;
  queuedSteer: SteerInput[];
  stopRemainingToolBatch: boolean;
}

export class AgentLoop {
  private readonly compactor: AgentCompactionService | null;
  private readonly security: SecurityService;
  private readonly skillsResolver: AgentSkillsResolver;
  private readonly bootstrapResolver: AgentBootstrapResolver;
  private readonly memoryResolver: AgentMemoryResolver;
  private readonly approvalWaits = new SessionApprovalWaitRegistry();
  private readonly approvalFlow: SessionApprovalFlowRegistry;
  private readonly steerQueue = new SessionSteerQueueRegistry();
  private readonly defaultMaxTurns: number;
  private readonly approvalTimeoutMs: number;
  private readonly approvalGrantTtlMs: number;

  constructor(private readonly deps: AgentLoopDependencies) {
    this.security = new SecurityService(
      deps.storage,
      buildSystemPolicy({ security: deps.securityConfig }),
    );
    this.skillsResolver = deps.skillsResolver ?? new FilesystemAgentSkillsResolver();
    this.bootstrapResolver = deps.bootstrapResolver ?? new FilesystemAgentBootstrapResolver();
    this.memoryResolver = deps.memoryResolver ?? new FilesystemAgentMemoryResolver();
    this.approvalFlow = deps.approvalFlow ?? new SessionApprovalFlowRegistry();
    this.defaultMaxTurns = deps.runtime?.maxTurns ?? DEFAULT_RUNTIME_MAX_TURNS;
    this.approvalTimeoutMs =
      deps.approvalTimeoutMs ??
      deps.runtime?.approvalTimeoutMs ??
      DEFAULT_RUNTIME_APPROVAL_TIMEOUT_MS;
    this.approvalGrantTtlMs =
      deps.approvalGrantTtlMs ??
      deps.runtime?.approvalGrantTtlMs ??
      DEFAULT_RUNTIME_APPROVAL_GRANT_TTL_MS;
    this.compactor = isCompactionModelRunner(deps.modelRunner)
      ? new AgentCompactionService({
          sessions: deps.sessions,
          models: deps.models,
          runner: deps.modelRunner,
          config: deps.compaction,
        })
      : null;
  }

  submitApprovalResponse(input: ApprovalResponseInput): boolean {
    return this.approvalWaits.resolveApproval(input);
  }

  private createToolExecutionContext(input: {
    sessionId: string;
    conversationId: string;
    sessionPurpose?: string;
    ownerAgentId?: string | null;
    agentKind?: string | null;
    cwd?: string;
    signal: AbortSignal;
    toolCallId: string;
    approvalState?: ToolExecutionApprovalState;
  }): ToolExecutionContext {
    const runtimeControl = {
      submitApprovalDecision: (decision) => this.submitApprovalResponse(decision),
      getRuntimeStatus: (request) => {
        const now = new Date();
        if (request?.runId != null && request.runId.length > 0) {
          const run = this.deps.control?.getRunObservability(request.runId, now) ?? null;
          if (run == null) {
            return {
              now: now.toISOString(),
              found: false as const,
              runId: request.runId,
              message:
                "Current live runtime status was not found for that run. It may have already completed, failed, been cancelled, or been lost after process restart.",
            };
          }

          return {
            now: now.toISOString(),
            found: true as const,
            run,
          };
        }

        return {
          now: now.toISOString(),
          runs: this.deps.control?.listActiveRunObservability(now) ?? [],
        };
      },
      ...(this.deps.runtimeControl ?? {}),
    } satisfies ToolRuntimeControl;

    return {
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      ...(input.sessionPurpose === undefined ? {} : { sessionPurpose: input.sessionPurpose }),
      cwd: input.cwd ?? POKOCLAW_WORKSPACE_DIR,
      securityConfig: this.deps.securityConfig,
      storage: this.deps.storage,
      abortSignal: input.signal,
      toolCallId: input.toolCallId,
      ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId }),
      ...(input.agentKind === undefined ? {} : { agentKind: input.agentKind }),
      ...(input.approvalState == null ? {} : { approvalState: input.approvalState }),
      runtimeControl,
    };
  }

  // Runtime-level steer injection. Session lanes call this while a run is
  // active so the new message can be inserted at the next safe boundary.
  enqueueSteerInput(input: {
    sessionId: string;
    content: string;
    userPayload?: AgentUserPayload;
    runtimeImages?: AgentUserRuntimeImagePayload[];
    messageType?: string;
    visibility?: string;
    channelMessageId?: string | null;
    channelParentMessageId?: string | null;
    channelThreadId?: string | null;
    createdAt?: Date;
  }): boolean {
    if (!this.deps.cancel.isActive(input.sessionId)) {
      return false;
    }

    this.handleApprovalInterventionOnSteer(input);
    this.steerQueue.enqueue(input);
    return true;
  }

  private handleApprovalInterventionOnSteer(input: {
    sessionId: string;
    content: string;
    createdAt?: Date;
  }): void {
    const activeApprovalId = this.approvalWaits.getPendingApprovalId(input.sessionId);
    if (activeApprovalId == null) {
      return;
    }

    const decidedAt = input.createdAt ?? new Date();
    const sessionContext = this.deps.sessions.getContext(input.sessionId);
    const activeApproval = this.security.getApprovalById(activeApprovalId);
    const activeRunId = parseApprovalResumeRunId(activeApproval);
    const pendingApprovals = this.security.listApprovalsBySession(input.sessionId, {
      statuses: ["pending"],
      limit: 100,
    });
    const autoRejectedApprovalIds = pendingApprovals
      .filter(
        (approval) =>
          approval.id !== activeApprovalId && approvalBelongsToActiveRound(approval, activeRunId),
      )
      .map((approval) => approval.id);

    for (const approvalId of autoRejectedApprovalIds) {
      const approval = pendingApprovals.find((entry) => entry.id === approvalId) ?? null;
      if (approval == null) {
        continue;
      }
      this.security.resolveApproval({
        approvalId,
        status: "denied",
        reasonText: APPROVAL_INTERVENTION_REASON_TEXT,
        decidedAt,
      });
      this.emitDetachedApprovalResolvedEvent({
        session: sessionContext.session,
        approval,
        runId: parseApprovalResumeRunId(approval) ?? activeRunId ?? "unknown",
        actor: "user:intervention",
        rawInput: input.content,
      });
    }

    this.recordApprovalInterventionFact({
      session: sessionContext.session,
      runId: activeRunId ?? `approval-intervention:${input.sessionId}`,
      activeApprovalId,
      autoRejectedApprovalIds: [activeApprovalId, ...autoRejectedApprovalIds],
      decidedAt,
    });

    this.approvalWaits.cancelSession({
      sessionId: input.sessionId,
      actor: "user:intervention",
      rawInput: input.content,
      reasonText: APPROVAL_INTERVENTION_REASON_TEXT,
      decidedAt,
    });
  }

  private markRunWaitingForFirstToken(runId: string, assistantMessageId: string): void {
    this.deps.control?.markLlmRequestStarted({
      runId,
      assistantMessageId,
    });
  }

  private recordStreamDelta(input: {
    runId: string;
    kind: "text" | "reasoning";
    deltaText?: string;
  }): void {
    this.deps.control?.recordStreamDelta(input);
  }

  private markToolRunning(runId: string, toolCall: AgentToolCall): void {
    this.deps.control?.markToolStarted({
      runId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
  }

  private markToolFinished(runId: string, toolCall: AgentToolCall): void {
    this.deps.control?.markToolFinished({
      runId,
      toolCallId: toolCall.id,
    });
  }

  private markWaitingApproval(runId: string, approvalId: number): void {
    this.deps.control?.markWaitingApproval({
      runId,
      approvalId: String(approvalId),
    });
  }

  private clearWaitingApproval(runId: string): void {
    this.deps.control?.clearWaitingApproval(runId);
  }

  async run(input: RunAgentLoopInput): Promise<RunAgentLoopResult> {
    const handle = this.deps.cancel.begin(input.sessionId);
    const maxTurns = input.maxTurns ?? this.defaultMaxTurns;
    let context = this.deps.sessions.getContext(input.sessionId);
    const runtimeImagesByMessageId = new Map<string, AgentUserRuntimeImagePayload[]>(
      Object.entries(input.initialRuntimeImagesByMessageId ?? {}),
    );
    const activeTurnImageMessageIds = new Set(
      Object.keys(input.initialRuntimeImagesByMessageId ?? {}),
    );
    logger.debug("initialized run runtime image state", {
      sessionId: input.sessionId,
      initialImageMessageIds: [...activeTurnImageMessageIds],
      initialRuntimeImageCount: [...runtimeImagesByMessageId.values()].reduce(
        (sum, images) => sum + images.length,
        0,
      ),
      initialRuntimeImages: [...runtimeImagesByMessageId.entries()].flatMap(([messageId, images]) =>
        images.map((image) => ({
          storageMessageId: messageId,
          id: image.id,
          messageId: image.messageId,
          mimeType: image.mimeType,
          byteLength: Buffer.from(image.data, "base64").length,
        })),
      ),
    });
    const models = resolveProviderRegistry(this.deps.models);
    const model = models.getRequiredScenarioModel(input.scenario);
    assertSessionModelSupportsTools({
      sessionPurpose: context.session.purpose,
      scenario: input.scenario,
      model,
    });
    const ownerAgent =
      context.session.ownerAgentId == null
        ? null
        : new AgentsRepo(this.deps.storage).getById(context.session.ownerAgentId);
    const ownerAgentId = context.session.ownerAgentId;
    const privateWorkspaceDir =
      ownerAgent?.kind === "sub" && ownerAgent.id.length > 0
        ? buildSubagentWorkspaceDir(ownerAgent.id)
        : null;
    const promptRuntimeContext = resolveLocalCalendarContext();
    const memorySnapshot = this.memoryResolver.resolveForRun({
      agentKind: ownerAgent?.kind ?? null,
      privateWorkspaceDir,
    });
    const bootstrapSnapshot = this.bootstrapResolver.resolveForRun({
      sessionPurpose: context.session.purpose,
      agentKind: ownerAgent?.kind ?? null,
    });
    const resolvedSkillsSnapshot = this.skillsResolver.resolveForRun({
      workdir: ownerAgent?.workdir ?? null,
    });
    const skillsSnapshot =
      context.session.purpose === "approval"
        ? filterSkillCatalogSnapshot(resolvedSkillsSnapshot, {
            allowedSources: ["builtin"],
          })
        : resolvedSkillsSnapshot;
    const readableSkillsSnapshot =
      ownerAgentId == null
        ? skillsSnapshot
        : filterReadableSkillCatalogSnapshot(skillsSnapshot, {
            canReadPath: (absolutePath) =>
              this.security.checkFilesystemAccess({
                ownerAgentId,
                kind: "fs.read",
                targetPath: absolutePath,
              }).result === "allow",
          });
    const systemPrompt = buildAgentSystemPrompt({
      sessionPurpose: context.session.purpose,
      agentKind: ownerAgent?.kind ?? null,
      displayName: ownerAgent?.displayName ?? null,
      description: ownerAgent?.description ?? null,
      currentDate: promptRuntimeContext.currentDate,
      timezone: promptRuntimeContext.timezone,
      workdir: ownerAgent?.workdir ?? null,
      privateWorkspaceDir,
      bootstrapPrompt: bootstrapSnapshot?.prompt ?? null,
      memoryCatalog: memorySnapshot.prompt,
      skillsCatalog: readableSkillsSnapshot.prompt,
    });
    let messages = [...context.messages];
    const events: AgentRuntimeEvent[] = [];
    const appendedMessageIds: string[] = [];
    let toolExecutions = 0;
    let stopSignal: AgentLoopStopSignal | null = null;
    let nextSeq = this.deps.messages.getNextSeq(input.sessionId);
    const runId = randomUUID();
    this.deps.control?.beginRun({
      runId,
      sessionId: input.sessionId,
      conversationId: context.session.conversationId,
      branchId: context.session.branchId,
      scenario: input.scenario,
    });
    let compactionRequested = false;
    let latestCompaction = decideCompaction({
      contextTokens: 0,
      contextWindow: model.contextWindow,
      config: this.deps.compaction,
    });

    try {
      this.recordEvent(events, {
        type: "run_started",
        scenario: input.scenario,
        modelId: model.id,
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        runId,
      });

      let completed = false;
      for (let turn = 0; turn < maxTurns; turn += 1) {
        throwIfAborted(handle.signal);
        let turnToolExecutions = 0;
        logger.debug("starting model turn", {
          sessionId: input.sessionId,
          turn: turn + 1,
          runId,
          tail: summarizeTranscriptTail(messages),
        });

        this.recordEvent(events, {
          type: "turn_started",
          turn: turn + 1,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        const assistantMessageId = randomUUID();
        let sawStreamedText = false;
        let sawStreamedReasoning = false;
        let streamedAssistantText = "";
        let streamedReasoningText = "";
        let streamedReasoningDeltaCount = 0;
        let streamedReasoningChars = 0;
        let overflowRecovered = false;
        let emptyOutputRetryCount = 0;
        let response: AgentModelTurnResult;

        while (true) {
          logger.info("requesting assistant response", {
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            scenario: input.scenario,
            turn: turn + 1,
            runId,
            assistantMessageId,
            modelId: model.id,
          });
          this.recordEvent(events, {
            type: "assistant_message_started",
            turn: turn + 1,
            messageId: assistantMessageId,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });
          this.markRunWaitingForFirstToken(runId, assistantMessageId);

          try {
            response = await this.deps.modelRunner.runTurn({
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              scenario: input.scenario,
              sessionPurpose: context.session.purpose,
              agentKind: ownerAgent?.kind ?? null,
              model,
              systemPrompt,
              compactSummary: context.compactSummary,
              messages,
              resolveRuntimeImages: (message) => {
                const mapped = runtimeImagesByMessageId.get(message.id) ?? [];
                logger.debug("resolved runtime images for model turn message", {
                  sessionId: input.sessionId,
                  runId,
                  storageMessageId: message.id,
                  activeTurnHasMessageId: activeTurnImageMessageIds.has(message.id),
                  runtimeImageMapHasMessageId: runtimeImagesByMessageId.has(message.id),
                  resolvedImageCount: mapped.length,
                  activeTurnImageMessageIds: [...activeTurnImageMessageIds],
                  availableRuntimeImageMessageIds: [...runtimeImagesByMessageId.keys()],
                  images: mapped.map((image) => ({
                    id: image.id,
                    messageId: image.messageId,
                    mimeType: image.mimeType,
                    byteLength: Buffer.from(image.data, "base64").length,
                  })),
                });
                return mapped;
              },
              signal: handle.signal,
              onTextDelta: (event) => {
                sawStreamedText = true;
                streamedAssistantText = event.accumulatedText;
                this.recordStreamDelta({
                  runId,
                  kind: "text",
                  deltaText: event.delta,
                });
                this.recordEvent(events, {
                  type: "assistant_message_delta",
                  turn: turn + 1,
                  messageId: assistantMessageId,
                  delta: event.delta,
                  accumulatedText: event.accumulatedText,
                  sessionId: input.sessionId,
                  conversationId: context.session.conversationId,
                  branchId: context.session.branchId,
                  runId,
                });
              },
              onThinkingDelta: (event) => {
                sawStreamedReasoning = true;
                streamedReasoningText += event.delta;
                streamedReasoningDeltaCount += 1;
                streamedReasoningChars += event.delta.length;
                this.recordStreamDelta({
                  runId,
                  kind: "reasoning",
                });
                if (streamedReasoningDeltaCount === 1 && event.delta.length > 0) {
                  logger.debug("assistant reasoning started", {
                    sessionId: input.sessionId,
                    conversationId: context.session.conversationId,
                    branchId: context.session.branchId,
                    scenario: input.scenario,
                    turn: turn + 1,
                    runId,
                    assistantMessageId,
                    modelId: model.id,
                    deltaPreview: truncateLogText(
                      event.delta,
                      ASSISTANT_REASONING_LOG_PREVIEW_MAX_LENGTH,
                    ),
                  });
                }
                this.recordEvent(events, {
                  type: "assistant_reasoning_delta",
                  turn: turn + 1,
                  messageId: assistantMessageId,
                  delta: event.delta,
                  sessionId: input.sessionId,
                  conversationId: context.session.conversationId,
                  branchId: context.session.branchId,
                  runId,
                });
              },
            });
            break;
          } catch (error) {
            if (
              !overflowRecovered &&
              isAgentLlmError(error) &&
              error.kind === "context_overflow" &&
              this.compactor != null
            ) {
              latestCompaction = decideCompaction({
                contextTokens: 0,
                contextWindow: model.contextWindow,
                config: this.deps.compaction,
                overflow: true,
              });
              compactionRequested = true;
              this.recordEvent(events, {
                type: "compaction_requested",
                reason: "overflow",
                thresholdTokens: latestCompaction.thresholdTokens,
                effectiveWindow: latestCompaction.effectiveWindow,
                sessionId: input.sessionId,
                conversationId: context.session.conversationId,
                branchId: context.session.branchId,
                runId,
              });
              logger.info("context overflow; compacting before retry", {
                sessionId: input.sessionId,
                modelId: model.id,
                runId,
              });

              const compactionResult = await this.compactor.compactNow({
                sessionId: input.sessionId,
                conversationId: context.session.conversationId,
                branchId: context.session.branchId,
                runId,
                reason: "overflow",
                signal: handle.signal,
                emitEvent: (event) => this.recordEvent(events, event),
              });

              if (!compactionResult.compacted) {
                throw error;
              }

              logger.info("compaction finished; retrying turn", {
                sessionId: input.sessionId,
                cursor: compactionResult.compactCursor,
                summaryTokens: compactionResult.summaryTokenTotal,
                runId,
              });

              overflowRecovered = true;
              sawStreamedText = false;
              sawStreamedReasoning = false;
              streamedAssistantText = "";
              streamedReasoningText = "";
              context = this.deps.sessions.getContext(input.sessionId);
              messages = [...context.messages];
              continue;
            }

            const emptyOutputRetryError = getRetryableLlmFailureWithoutVisibleOutput({
              error,
              sawStreamedText,
              sawStreamedReasoning,
              retryCount: emptyOutputRetryCount,
            });
            if (emptyOutputRetryError != null) {
              emptyOutputRetryCount += 1;
              logger.warn("retrying assistant response after empty-output llm failure", {
                sessionId: input.sessionId,
                conversationId: context.session.conversationId,
                branchId: context.session.branchId,
                scenario: input.scenario,
                turn: turn + 1,
                runId,
                assistantMessageId,
                modelId: model.id,
                errorKind: emptyOutputRetryError.kind,
                errorMessage: emptyOutputRetryError.message,
                retryAttempt: emptyOutputRetryCount,
                retryLimit: EMPTY_OUTPUT_LLM_RETRY_LIMIT,
              });
              continue;
            }

            nextSeq = appendPartialStreamedAssistantMessageOnFailure({
              repo: this.deps.messages,
              sessionId: input.sessionId,
              messageId: assistantMessageId,
              nextSeq,
              appendedMessageIds,
              messages,
              turn: turn + 1,
              runId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              modelId: model.upstreamId,
              providerId: model.provider.id,
              modelApi: model.provider.api,
              text: streamedAssistantText,
              reasoningText: streamedReasoningText,
              errorMessage: getErrorMessage(error),
              recordEvent: (event) => this.recordEvent(events, event),
            });
            throw error;
          }
        }

        throwIfAborted(handle.signal);

        const assistantText = collectAssistantText(response.content);
        const reasoningText = collectAssistantThinking(response.content);
        const toolCalls = collectAgentToolCalls(response.content);
        const successfulEmptyOutputRetry = shouldRetrySuccessfulEmptyAssistantOutput({
          assistantText,
          reasoningText,
          toolCallsRequested: toolCalls.length,
          sawStreamedText,
          sawStreamedReasoning,
          retryCount: emptyOutputRetryCount,
        });
        if (successfulEmptyOutputRetry) {
          emptyOutputRetryCount += 1;
          logger.warn("retrying assistant response after successful empty output", {
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            scenario: input.scenario,
            turn: turn + 1,
            runId,
            assistantMessageId,
            modelId: model.id,
            retryAttempt: emptyOutputRetryCount,
            retryLimit: EMPTY_OUTPUT_LLM_RETRY_LIMIT,
          });
          continue;
        }
        // Some runners will stream deltas incrementally, others may only return
        // the final assistant payload. We keep one event shape and only fall back
        // to a single full-text delta if nothing was streamed.
        if (!sawStreamedText && assistantText.length > 0) {
          this.recordStreamDelta({
            runId,
            kind: "text",
            deltaText: assistantText,
          });
          this.recordEvent(events, {
            type: "assistant_message_delta",
            turn: turn + 1,
            messageId: assistantMessageId,
            delta: assistantText,
            accumulatedText: assistantText,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });
        }
        const assistantMessage = appendMessageAndHydrate({
          repo: this.deps.messages,
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          seq: nextSeq,
          role: "assistant",
          messageType: "text",
          visibility: "user_visible",
          provider: response.provider,
          model: response.model,
          modelApi: response.modelApi,
          stopReason: response.stopReason,
          errorMessage: response.errorMessage ?? null,
          payload: {
            content: response.content,
          } satisfies AgentAssistantPayload,
          usage: response.usage,
          createdAt: new Date(),
        });
        nextSeq = assistantMessage.seq + 1;
        messages.push(assistantMessage);
        appendedMessageIds.push(assistantMessageId);
        logger.info("assistant response completed", {
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          scenario: input.scenario,
          turn: turn + 1,
          runId,
          assistantMessageId,
          modelId: model.id,
          stopReason: response.stopReason,
          toolCalls: toolCalls.length,
          textPreview: truncateLogText(assistantText, ASSISTANT_RESPONSE_LOG_PREVIEW_MAX_LENGTH),
        });
        this.deps.control?.setFinalOutputTokens({
          runId,
          outputTokens: response.usage.output,
        });
        if (sawStreamedReasoning || reasoningText.length > 0) {
          logger.debug("assistant reasoning completed", {
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            scenario: input.scenario,
            turn: turn + 1,
            runId,
            assistantMessageId,
            modelId: model.id,
            streamed: sawStreamedReasoning,
            deltaCount: streamedReasoningDeltaCount,
            streamedChars: streamedReasoningChars,
            finalChars: reasoningText.length,
            finalPreview:
              reasoningText.length > 0
                ? truncateLogText(reasoningText, ASSISTANT_REASONING_LOG_PREVIEW_MAX_LENGTH)
                : "",
          });
        }
        this.recordEvent(events, {
          type: "assistant_message_completed",
          turn: turn + 1,
          messageId: assistantMessageId,
          text: assistantText,
          reasoningText: !sawStreamedReasoning && reasoningText.length > 0 ? reasoningText : null,
          toolCalls,
          usage: response.usage,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        if (toolCalls.length === 0) {
          const queuedSteer = this.steerQueue.drain(input.sessionId);
          if (queuedSteer.length > 0) {
            logger.info("steering inbound message after turn", {
              sessionId: input.sessionId,
              turn: turn + 1,
              runId,
              count: queuedSteer.length,
              latest: truncateLogText(queuedSteer.at(-1)?.content ?? "", 48),
            });
            const queuedMessages = this.appendQueuedSteerMessages({
              queuedSteer,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
              events,
              turn: turn + 1,
              nextSeq,
              messages,
              appendedMessageIds,
              runtimeImagesByMessageId,
            });
            nextSeq = queuedMessages.nextSeq;
            replaceActiveTurnRuntimeImages({
              activeTurnImageMessageIds,
              runtimeImagesByMessageId,
              nextMessageIds: queuedMessages.messageIds,
            });
          }

          this.recordEvent(events, {
            type: "turn_completed",
            turn: turn + 1,
            toolCallsRequested: 0,
            toolExecutions: 0,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });

          if (queuedSteer.length > 0) {
            continue;
          }
          completed = true;
          break;
        }

        const queuedSteerAfterTurn: SteerInput[] = [];
        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
          const toolCall = toolCalls[toolIndex];
          if (toolCall == null) {
            continue;
          }
          throwIfAborted(handle.signal);

          this.recordEvent(events, {
            type: "tool_call_started",
            turn: turn + 1,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.args,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
          });
          this.markToolRunning(runId, toolCall);

          try {
            const executedTool = await this.executeToolCall({
              input,
              context,
              ownerAgent,
              messages,
              toolCall,
              turn: turn + 1,
              runId,
              events,
              signal: handle.signal,
            });

            throwIfAborted(handle.signal);

            const toolResultMessageId = randomUUID();
            const toolResultMessage = appendMessageAndHydrate({
              repo: this.deps.messages,
              sessionId: input.sessionId,
              messageId: toolResultMessageId,
              seq: nextSeq,
              role: "tool",
              messageType: "tool_result",
              visibility: "hidden_system",
              payload: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: executedTool.result.content,
                isError: executedTool.isError,
                ...(executedTool.result.details !== undefined
                  ? { details: executedTool.result.details }
                  : {}),
              } satisfies AgentToolResultPayload,
              createdAt: new Date(),
            });
            nextSeq = toolResultMessage.seq + 1;
            messages.push(toolResultMessage);
            appendedMessageIds.push(toolResultMessageId);
            toolExecutions += 1;
            turnToolExecutions += 1;
            this.recordEvent(events, {
              type: "tool_call_completed",
              turn: turn + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              messageId: toolResultMessageId,
              result: executedTool.result,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
            });
            this.markToolFinished(runId, toolCall);

            if (executedTool.queuedSteer.length > 0) {
              queuedSteerAfterTurn.push(...executedTool.queuedSteer);
            }

            if (executedTool.stopRemainingToolBatch) {
              for (const skippedToolCall of toolCalls.slice(toolIndex + 1)) {
                const abortedResult = buildAbortedToolBatchResult();
                const abortedMessage = appendMessageAndHydrate({
                  repo: this.deps.messages,
                  sessionId: input.sessionId,
                  messageId: randomUUID(),
                  seq: nextSeq,
                  role: "tool",
                  messageType: "tool_result",
                  visibility: "hidden_system",
                  payload: {
                    toolCallId: skippedToolCall.id,
                    toolName: skippedToolCall.name,
                    content: abortedResult.content,
                    isError: true,
                    ...(abortedResult.details !== undefined
                      ? { details: abortedResult.details }
                      : {}),
                  } satisfies AgentToolResultPayload,
                  createdAt: new Date(),
                });
                nextSeq = abortedMessage.seq + 1;
                messages.push(abortedMessage);
                appendedMessageIds.push(abortedMessage.id);

                this.recordEvent(events, {
                  type: "tool_call_started",
                  turn: turn + 1,
                  toolCallId: skippedToolCall.id,
                  toolName: skippedToolCall.name,
                  args: skippedToolCall.args,
                  sessionId: input.sessionId,
                  conversationId: context.session.conversationId,
                  branchId: context.session.branchId,
                  runId,
                });
                this.recordEvent(events, {
                  type: "tool_call_failed",
                  turn: turn + 1,
                  toolCallId: skippedToolCall.id,
                  toolName: skippedToolCall.name,
                  errorKind: "recoverable_error",
                  errorMessage: extractPrimaryToolResultText(abortedResult),
                  rawErrorMessage: null,
                  retryable: false,
                  sessionId: input.sessionId,
                  conversationId: context.session.conversationId,
                  branchId: context.session.branchId,
                  runId,
                });
              }
              break;
            }

            const stopDecision = await input.afterToolResultHook?.afterToolResult({
              run: input,
              sessionPurpose: context.session.purpose,
              ownerAgentId: context.session.ownerAgentId,
              agentKind: ownerAgent?.kind ?? null,
              runId,
              turn: turn + 1,
              toolCall,
              result: executedTool.result,
            });
            if (stopDecision?.kind === "stop_run") {
              stopSignal = {
                reason: stopDecision.reason,
                ...(stopDecision.payload === undefined ? {} : { payload: stopDecision.payload }),
              };
              completed = true;
              break;
            }
          } catch (error) {
            throwIfAborted(handle.signal);
            const failure = normalizeToolFailure(error);
            if (failure.kind === "internal_error") {
              logger.warn("internal tool failure", {
                sessionId: input.sessionId,
                turn: turn + 1,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                raw: failure.rawMessage ?? failure.message,
                errorName: error instanceof Error ? error.name : typeof error,
                errorMessage: error instanceof Error ? error.message : String(error),
                stackTop:
                  error instanceof Error && typeof error.stack === "string"
                    ? truncateLogText(error.stack.split("\n").slice(0, 3).join(" | "), 220)
                    : undefined,
                runId,
              });
            }
            this.recordEvent(events, {
              type: "tool_call_failed",
              turn: turn + 1,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              errorKind: failure.kind,
              errorMessage: failure.message,
              rawErrorMessage: failure.rawMessage ?? null,
              retryable: failure.retryable,
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
            });
            this.markToolFinished(runId, toolCall);

            if (!failure.shouldReturnToLlm) {
              throw failure;
            }

            const toolResultMessageId = randomUUID();
            const toolResultMessage = appendMessageAndHydrate({
              repo: this.deps.messages,
              sessionId: input.sessionId,
              messageId: toolResultMessageId,
              seq: nextSeq,
              role: "tool",
              messageType: "tool_result",
              visibility: "hidden_system",
              payload: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: buildToolFailureContent(failure),
                isError: true,
                ...(failure.details !== undefined ? { details: failure.details } : {}),
              } satisfies AgentToolResultPayload,
              createdAt: new Date(),
            });
            nextSeq = toolResultMessage.seq + 1;
            messages.push(toolResultMessage);
            appendedMessageIds.push(toolResultMessageId);
            toolExecutions += 1;
            turnToolExecutions += 1;
          }
        }

        if (stopSignal != null) {
          break;
        }

        const queuedSteer = [...queuedSteerAfterTurn, ...this.steerQueue.drain(input.sessionId)];
        if (queuedSteer.length > 0) {
          logger.info("steering inbound message after tool batch", {
            sessionId: input.sessionId,
            turn: turn + 1,
            runId,
            count: queuedSteer.length,
            latest: truncateLogText(queuedSteer.at(-1)?.content ?? "", 48),
            tail: summarizeTranscriptTail(messages),
          });
          const queuedMessages = this.appendQueuedSteerMessages({
            queuedSteer,
            sessionId: input.sessionId,
            conversationId: context.session.conversationId,
            branchId: context.session.branchId,
            runId,
            events,
            turn: turn + 1,
            nextSeq,
            messages,
            appendedMessageIds,
            runtimeImagesByMessageId,
          });
          nextSeq = queuedMessages.nextSeq;
          replaceActiveTurnRuntimeImages({
            activeTurnImageMessageIds,
            runtimeImagesByMessageId,
            nextMessageIds: queuedMessages.messageIds,
          });
        }

        this.recordEvent(events, {
          type: "turn_completed",
          turn: turn + 1,
          toolCallsRequested: toolCalls.length,
          toolExecutions: turnToolExecutions,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        if (queuedSteer.length > 0) {
        }
      }

      if (!completed) {
        const error = new AgentLoopTurnLimitError(maxTurns);
        logger.warn("session run hit max turn limit", {
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          scenario: input.scenario,
          modelId: model.id,
          runId,
          maxTurns,
        });
        throw error;
      }

      const compactionEstimate = estimateSessionContextTokens({
        compactSummary: context.compactSummary,
        compactSummaryTokenTotal: context.compactSummaryTokenTotal,
        compactSummaryUsageJson: context.compactSummaryUsageJson,
        messages,
      });
      const compaction = decideCompaction({
        contextTokens: compactionEstimate.tokens,
        contextWindow: model.contextWindow,
        config: this.deps.compaction,
      });
      logger.debug("checked context size for compaction", {
        sessionId: input.sessionId,
        modelId: model.id,
        contextTokens: compactionEstimate.tokens,
        threshold: compaction.thresholdTokens,
        runId,
      });
      latestCompaction = compaction.shouldCompact ? compaction : latestCompaction;

      if (compaction.shouldCompact && compaction.reason != null) {
        compactionRequested = true;
        logger.info("queueing background compaction", {
          sessionId: input.sessionId,
          modelId: model.id,
          contextTokens: compactionEstimate.tokens,
          threshold: compaction.thresholdTokens,
          runId,
        });
        this.recordEvent(events, {
          type: "compaction_requested",
          reason: compaction.reason,
          thresholdTokens: compaction.thresholdTokens,
          effectiveWindow: compaction.effectiveWindow,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });

        if (this.compactor != null) {
          queueMicrotask(() => {
            void this.compactor?.schedule({
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              branchId: context.session.branchId,
              runId,
              reason: compaction.reason as "threshold",
              emitEvent: (event) => this.recordEvent(events, event),
            });
          });
        }
      }

      this.recordEvent(events, {
        type: "run_completed",
        scenario: input.scenario,
        modelId: model.id,
        appendedMessageIds: [...appendedMessageIds],
        toolExecutions,
        compactionRequested,
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        runId,
      });
      this.deps.control?.markCompleted({ runId });
      logger.info("session run completed", {
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        scenario: input.scenario,
        modelId: model.id,
        runId,
        appendedMessages: appendedMessageIds.length,
        toolExecutions,
        compactionRequested,
      });

      return {
        runId,
        sessionId: input.sessionId,
        scenario: input.scenario,
        modelId: model.id,
        appendedMessageIds,
        toolExecutions,
        compaction: latestCompaction,
        events,
        stopSignal,
      };
    } catch (error) {
      if (handle.signal.aborted) {
        const signalReason = handle.signal.reason;
        const reason =
          typeof signalReason === "string" && signalReason.length > 0
            ? signalReason
            : getErrorMessage(error);
        this.recordEvent(events, {
          type: "run_cancelled",
          scenario: input.scenario,
          modelId: model.id,
          reason,
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          runId,
        });
        this.deps.control?.markCancelled({ runId });
        logger.warn("session run cancelled", {
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          branchId: context.session.branchId,
          scenario: input.scenario,
          modelId: model.id,
          runId,
          reason,
        });
        throw error;
      }

      const normalizedError = toRunFailure(error);
      this.recordEvent(events, {
        type: "run_failed",
        scenario: input.scenario,
        modelId: model.id,
        errorKind: normalizedError.kind,
        errorMessage: normalizedError.message,
        ...(normalizedError.rawMessage == null
          ? {}
          : { rawErrorMessage: normalizedError.rawMessage }),
        retryable: normalizedError.retryable,
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        runId,
      });
      this.deps.control?.markFailed({ runId });
      logger.error("session run failed", {
        sessionId: input.sessionId,
        conversationId: context.session.conversationId,
        branchId: context.session.branchId,
        scenario: input.scenario,
        modelId: model.id,
        runId,
        errorKind: normalizedError.kind,
        errorMessage: normalizedError.message,
        ...(normalizedError.rawMessage == null
          ? {}
          : { rawErrorMessage: normalizedError.rawMessage }),
      });
      throw error;
    } finally {
      this.steerQueue.clear(input.sessionId);
      this.deps.control?.finishRun(runId);
      handle.finish();
    }
  }

  private async executeToolCall(input: {
    input: RunAgentLoopInput;
    context: ReturnType<AgentSessionService["getContext"]>;
    ownerAgent: ReturnType<AgentsRepo["getById"]>;
    messages: Message[];
    toolCall: AgentToolCall;
    turn: number;
    runId: string;
    events: AgentRuntimeEvent[];
    signal: AbortSignal;
  }): Promise<ExecutedToolCall> {
    const queuedSteer: SteerInput[] = [];
    let approvalState: ToolExecutionApprovalState | undefined;

    while (true) {
      try {
        assertToolAllowedForSession({
          purpose: input.context.session.purpose,
          agentKind: input.ownerAgent?.kind ?? null,
          toolName: input.toolCall.name,
        });
        const result = await this.deps.tools.execute(
          input.toolCall.name,
          this.createToolExecutionContext({
            sessionId: input.input.sessionId,
            conversationId: input.context.session.conversationId,
            sessionPurpose: input.context.session.purpose,
            ownerAgentId: input.context.session.ownerAgentId,
            agentKind: input.ownerAgent?.kind ?? null,
            signal: input.signal,
            toolCallId: input.toolCall.id,
            ...(input.ownerAgent?.workdir == null ? {} : { cwd: input.ownerAgent.workdir }),
            ...(approvalState == null ? {} : { approvalState }),
          }),
          input.toolCall.args,
        );

        return {
          result,
          isError: false,
          queuedSteer,
          stopRemainingToolBatch: false,
        };
      } catch (error) {
        if (!isToolApprovalRequired(error)) {
          throw error;
        }

        const approval = await requestToolApproval({
          storage: this.deps.storage,
          security: this.security,
          approvalWaits: this.approvalWaits,
          approvalFlow: this.approvalFlow,
          sessions: this.deps.sessions,
          approvalTimeoutMs: this.approvalTimeoutMs,
          runInput: input.input,
          session: input.context.session,
          toolCall: input.toolCall,
          turn: input.turn,
          runId: input.runId,
          request: error.request,
          reasonText: error.reasonText,
          ...(error.approvalTitle == null ? {} : { approvalTitle: error.approvalTitle }),
          ...(error.approvalCommand == null ? {} : { approvalCommand: error.approvalCommand }),
          grantOnApprove: error.grantOnApprove,
          signal: input.signal,
          recordEvent: (event) => this.recordEvent(input.events, event),
          onRequested: ({ approvalId }) => this.markWaitingApproval(input.runId, approvalId),
        });
        this.clearWaitingApproval(input.runId);

        if (approval.decision === "approve") {
          queuedSteer.push(...approval.queuedSteer);
          if (error.grantOnApprove) {
            const grantedBy = approval.grantedBy ?? "user";
            const grantExpiresAt =
              approval.expiresAt === undefined
                ? new Date(approval.decidedAt.getTime() + this.approvalGrantTtlMs)
                : approval.expiresAt;

            this.security.approveRequestAndGrantScopes({
              approvalId: approval.approvalId,
              grantedBy,
              reasonText: approval.reasonText,
              decidedAt: approval.decidedAt,
              expiresAt: grantExpiresAt,
            });
          } else {
            this.security.resolveApproval({
              approvalId: approval.approvalId,
              status: "approved",
              reasonText: approval.reasonText,
              decidedAt: approval.decidedAt,
            });
          }

          approvalState = error.approvalState;
          this.markToolRunning(input.runId, input.toolCall);

          if (input.toolCall.name === "request_permissions") {
            return await this.finishPermissionRequestAfterApproval({
              input,
              approval,
              queuedSteer,
              ...(error.retryToolCallId == null ? {} : { retryToolCallId: error.retryToolCallId }),
            });
          }

          continue;
        }

        this.security.resolveApproval({
          approvalId: approval.approvalId,
          status: "denied",
          reasonText: approval.reasonText,
          decidedAt: approval.decidedAt,
        });

        return {
          result:
            input.toolCall.name === "request_permissions"
              ? textToolResult(
                  renderPermissionRequestResultBlock({
                    status: "denied",
                    justification:
                      approval.reasonText == null || approval.reasonText.length === 0
                        ? "Permission request denied."
                        : approval.reasonText,
                    ...(error.retryToolCallId == null
                      ? {}
                      : { retryToolCallId: error.retryToolCallId }),
                  }),
                  {
                    ...(approval.actor === "user:intervention"
                      ? { code: APPROVAL_DENIED_USER_INTERVENTION_CODE }
                      : {}),
                    approvalId: approval.approvalId,
                    request: approval.request,
                  },
                )
              : textToolResult(
                  approval.reasonText == null || approval.reasonText.length === 0
                    ? "Permission request denied."
                    : approval.reasonText,
                  {
                    ...(approval.actor === "user:intervention"
                      ? { code: APPROVAL_DENIED_USER_INTERVENTION_CODE }
                      : {}),
                    approvalId: approval.approvalId,
                    request: approval.request,
                  },
                ),
          isError: true,
          queuedSteer: [...queuedSteer, ...approval.queuedSteer],
          stopRemainingToolBatch: approval.actor === "user:intervention",
        };
      }
    }
  }

  private async finishPermissionRequestAfterApproval(input: {
    input: {
      input: RunAgentLoopInput;
      context: ReturnType<AgentSessionService["getContext"]>;
      ownerAgent: ReturnType<AgentsRepo["getById"]>;
      messages: Message[];
      toolCall: AgentToolCall;
      turn: number;
      runId: string;
      events: AgentRuntimeEvent[];
      signal: AbortSignal;
    };
    approval: ApprovalWaitOutcome & { approvalId: number; request: PermissionRequest };
    queuedSteer: SteerInput[];
    retryToolCallId?: string;
  }): Promise<ExecutedToolCall> {
    if (input.retryToolCallId == null) {
      logger.info("permission request approved without retry", {
        sessionId: input.input.input.sessionId,
        approvalId: input.approval.approvalId,
        toolName: input.input.toolCall.name,
        runId: input.input.runId,
      });
      return {
        result: textToolResult(
          renderPermissionRequestResultBlock({
            status: "approved",
            justification: input.approval.reasonText ?? "Permission request approved.",
          }),
          {
            approvalId: input.approval.approvalId,
            request: input.approval.request,
          },
        ),
        isError: false,
        queuedSteer: input.queuedSteer,
        stopRemainingToolBatch: false,
      };
    }

    const retryTarget = findAssistantToolCallById(input.input.messages, input.retryToolCallId);
    if (retryTarget == null) {
      logger.warn("permission retry target missing", {
        sessionId: input.input.input.sessionId,
        approvalId: input.approval.approvalId,
        retryToolCallId: input.retryToolCallId,
        runId: input.input.runId,
      });
      return {
        result: textToolResult(
          `${renderPermissionRequestResultBlock({
            status: "approved",
            justification: input.approval.reasonText ?? "Permission request approved.",
            retryToolCallId: input.retryToolCallId,
          })}\n\nAutomatic retry could not find the original tool call. Retry it manually if needed.`,
          {
            approvalId: input.approval.approvalId,
            request: input.approval.request,
          },
        ),
        isError: true,
        queuedSteer: input.queuedSteer,
        stopRemainingToolBatch: false,
      };
    }

    try {
      logger.info("retrying blocked tool after approval", {
        sessionId: input.input.input.sessionId,
        approvalId: input.approval.approvalId,
        retryToolCallId: input.retryToolCallId,
        retriedToolName: retryTarget.name,
        runId: input.input.runId,
      });
      assertToolAllowedForSession({
        purpose: input.input.context.session.purpose,
        agentKind: input.input.ownerAgent?.kind ?? null,
        toolName: retryTarget.name,
      });
      const retriedResult = await this.deps.tools.execute(
        retryTarget.name,
        this.createToolExecutionContext({
          sessionId: input.input.input.sessionId,
          conversationId: input.input.context.session.conversationId,
          ownerAgentId: input.input.context.session.ownerAgentId,
          agentKind: input.input.ownerAgent?.kind ?? null,
          signal: input.input.signal,
          toolCallId: retryTarget.id,
          ...(input.input.ownerAgent?.workdir == null
            ? {}
            : { cwd: input.input.ownerAgent.workdir }),
        }),
        retryTarget.args,
      );

      logger.info("retry completed after approval", {
        sessionId: input.input.input.sessionId,
        approvalId: input.approval.approvalId,
        retryToolCallId: input.retryToolCallId,
        retriedToolName: retryTarget.name,
        runId: input.input.runId,
      });

      return {
        result: {
          content: [
            {
              type: "text",
              text: renderPermissionRequestResultBlock({
                status: "approved",
                justification: input.approval.reasonText ?? "Permission request approved.",
                retryToolCallId: input.retryToolCallId,
                retriedToolName: retryTarget.name,
              }),
            },
            {
              type: "text",
              text: renderPermissionRetryDivider(),
            },
            ...retriedResult.content,
          ],
          ...(retriedResult.details === undefined ? {} : { details: retriedResult.details }),
        },
        isError: false,
        queuedSteer: input.queuedSteer,
        stopRemainingToolBatch: false,
      };
    } catch (error) {
      const failure = normalizeToolFailure(error);
      if (!failure.shouldReturnToLlm) {
        throw failure;
      }

      logger.info("retry failed after approval", {
        sessionId: input.input.input.sessionId,
        approvalId: input.approval.approvalId,
        retryToolCallId: input.retryToolCallId,
        retriedToolName: retryTarget.name,
        errorKind: failure.kind,
        runId: input.input.runId,
      });

      return {
        result: {
          content: [
            {
              type: "text",
              text: renderPermissionRequestResultBlock({
                status: "approved",
                justification: input.approval.reasonText ?? "Permission request approved.",
                retryToolCallId: input.retryToolCallId,
                retriedToolName: retryTarget.name,
              }),
            },
            {
              type: "text",
              text: renderPermissionRetryDivider(),
            },
            ...(isPermissionDeniedDetails(failure.details)
              ? [
                  {
                    type: "text" as const,
                    text: renderPermissionRetryNewBoundaryNote(),
                  },
                ]
              : []),
            ...buildToolFailureContent(failure),
          ],
          ...(failure.details === undefined ? {} : { details: failure.details }),
        },
        isError: true,
        queuedSteer: input.queuedSteer,
        stopRemainingToolBatch: false,
      };
    }
  }

  private appendQueuedSteerMessages(input: {
    queuedSteer: SteerInput[];
    sessionId: string;
    conversationId: string;
    branchId: string;
    runId: string;
    events: AgentRuntimeEvent[];
    turn: number;
    nextSeq: number;
    messages: Message[];
    appendedMessageIds: string[];
    runtimeImagesByMessageId: Map<string, AgentUserRuntimeImagePayload[]>;
  }): { nextSeq: number; messageIds: string[] } {
    let nextSeq = input.nextSeq;
    const messageIds: string[] = [];

    for (const queued of input.queuedSteer) {
      const messageId = randomUUID();
      const message = appendMessageAndHydrate({
        repo: this.deps.messages,
        sessionId: input.sessionId,
        messageId,
        seq: nextSeq,
        role: "user",
        payload:
          queued.userPayload ??
          ({
            content: queued.content,
          } satisfies AgentUserPayload),
        messageType: queued.messageType ?? "text",
        visibility: queued.visibility ?? "user_visible",
        channelMessageId: queued.channelMessageId ?? null,
        channelParentMessageId: queued.channelParentMessageId ?? null,
        channelThreadId: queued.channelThreadId ?? null,
        createdAt: queued.createdAt ?? new Date(),
      });
      if (queued.runtimeImages && queued.runtimeImages.length > 0) {
        input.runtimeImagesByMessageId.set(messageId, queued.runtimeImages);
        logger.debug("attached runtime images to queued steer message", {
          sessionId: input.sessionId,
          storageMessageId: messageId,
          runtimeImageCount: queued.runtimeImages.length,
          images: queued.runtimeImages.map((image) => ({
            id: image.id,
            messageId: image.messageId,
            mimeType: image.mimeType,
            byteLength: Buffer.from(image.data, "base64").length,
          })),
        });
      }
      nextSeq = message.seq + 1;
      messageIds.push(messageId);
      input.messages.push(message);
      input.appendedMessageIds.push(messageId);
      this.recordEvent(input.events, {
        type: "steer_message_consumed",
        turn: input.turn,
        messageId,
        channelMessageId: queued.channelMessageId ?? null,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        branchId: input.branchId,
        runId: input.runId,
      });
    }

    return { nextSeq, messageIds };
  }

  private recordEvent(events: AgentRuntimeEvent[], event: AgentRuntimeEventInput): void {
    const hydrated = {
      ...event,
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } satisfies AgentRuntimeEvent;

    events.push(hydrated);
    this.deps.emitEvent?.(hydrated);
  }

  private emitDetachedApprovalResolvedEvent(input: {
    session: Session;
    approval: ApprovalRecord;
    runId: string;
    actor: string;
    rawInput: string;
  }): void {
    this.deps.emitEvent?.({
      type: "approval_resolved",
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
      approvalId: String(input.approval.id),
      approvalFlowId: `approval_flow:detached:${input.approval.id}`,
      approvalAttemptIndex: 1,
      decision: "deny",
      actor: input.actor,
      rawInput: input.rawInput,
      flowContinues: false,
      sessionId: input.session.id,
      conversationId: input.session.conversationId,
      branchId: input.session.branchId,
      runId: input.runId,
    });
  }

  private recordApprovalInterventionFact(input: {
    session: Session;
    runId: string;
    activeApprovalId: number;
    autoRejectedApprovalIds: number[];
    decidedAt: Date;
  }): void {
    const harnessEvents = new HarnessEventsRepo(this.deps.storage);
    const taskRuns = new TaskRunsRepo(this.deps.storage);
    const taskRun = taskRuns.getByExecutionSessionId(input.session.id);
    harnessEvents.create({
      id: randomUUID(),
      eventType: "approval_intervened",
      runId: input.runId,
      sessionId: input.session.id,
      conversationId: input.session.conversationId,
      branchId: input.session.branchId,
      agentId: input.session.ownerAgentId ?? taskRun?.ownerAgentId ?? null,
      taskRunId: taskRun?.id ?? null,
      cronJobId: taskRun?.cronJobId ?? null,
      actor: "user",
      sourceKind: "message",
      requestScope: "approval_round",
      reasonText: APPROVAL_INTERVENTION_REASON_TEXT,
      detailsJson: JSON.stringify({
        activeApprovalId: input.activeApprovalId,
        rejectedApprovalIds: input.autoRejectedApprovalIds,
        rejectedApprovalCount: input.autoRejectedApprovalIds.length,
      }),
      createdAt: input.decidedAt,
    });
  }
}

function parseApprovalResumeRunId(approval: ApprovalRecord | null): string | null {
  if (approval?.resumePayloadJson == null || approval.resumePayloadJson.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(approval.resumePayloadJson) as { runId?: unknown };
    return typeof parsed.runId === "string" && parsed.runId.length > 0 ? parsed.runId : null;
  } catch {
    return null;
  }
}

function approvalBelongsToActiveRound(
  approval: ApprovalRecord,
  activeRunId: string | null,
): boolean {
  if (activeRunId == null) {
    return true;
  }

  return parseApprovalResumeRunId(approval) === activeRunId;
}

function buildAbortedToolBatchResult(): ToolResult {
  return textToolResult(
    "Skipped because the user sent a new message and redirected the run before this tool call started.",
    {
      code: TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE,
    },
  );
}

function extractPrimaryToolResultText(result: ToolResult): string {
  const firstTextBlock = result.content.find((block) => block.type === "text");
  return firstTextBlock?.text ?? "Tool call failed.";
}

function replaceActiveTurnRuntimeImages(input: {
  activeTurnImageMessageIds: Set<string>;
  runtimeImagesByMessageId: Map<string, AgentUserRuntimeImagePayload[]>;
  nextMessageIds: string[];
}): void {
  const previousActiveMessageIds = [...input.activeTurnImageMessageIds];
  for (const messageId of input.activeTurnImageMessageIds) {
    input.runtimeImagesByMessageId.delete(messageId);
  }
  input.activeTurnImageMessageIds.clear();
  for (const messageId of input.nextMessageIds) {
    if (!input.runtimeImagesByMessageId.has(messageId)) {
      continue;
    }
    input.activeTurnImageMessageIds.add(messageId);
  }
  logger.debug("replaced active turn runtime images", {
    previousActiveMessageIds,
    nextMessageIds: input.nextMessageIds,
    newActiveMessageIds: [...input.activeTurnImageMessageIds],
    remainingRuntimeImageMessageIds: [...input.runtimeImagesByMessageId.keys()],
  });
}

function appendMessageAndHydrate(input: {
  repo: MessagesRepo;
  sessionId: string;
  messageId: string;
  seq?: number;
  role: string;
  messageType: string;
  visibility: string;
  channelMessageId?: string | null;
  channelParentMessageId?: string | null;
  channelThreadId?: string | null;
  provider?: string | null;
  model?: string | null;
  modelApi?: string | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  payload: unknown;
  usage?: MessageUsage | null;
  createdAt: Date;
}): Message {
  const payloadJson = JSON.stringify(input.payload);
  let seq = input.seq ?? input.repo.getNextSeq(input.sessionId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      input.repo.append({
        id: input.messageId,
        sessionId: input.sessionId,
        seq,
        role: input.role,
        messageType: input.messageType,
        visibility: input.visibility,
        channelMessageId: input.channelMessageId ?? null,
        channelParentMessageId: input.channelParentMessageId ?? null,
        channelThreadId: input.channelThreadId ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        modelApi: input.modelApi ?? null,
        stopReason: input.stopReason ?? null,
        errorMessage: input.errorMessage ?? null,
        payloadJson,
        usage: input.usage ?? null,
        createdAt: input.createdAt,
      });
      break;
    } catch (error) {
      if (attempt === 0 && isMessageSeqUniqueConstraintError(error)) {
        seq = input.repo.getNextSeq(input.sessionId);
        continue;
      }
      throw error;
    }
  }

  return {
    id: input.messageId,
    sessionId: input.sessionId,
    seq,
    role: input.role,
    messageType: input.messageType,
    visibility: input.visibility,
    channelMessageId: input.channelMessageId ?? null,
    channelParentMessageId: input.channelParentMessageId ?? null,
    channelThreadId: input.channelThreadId ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    modelApi: input.modelApi ?? null,
    stopReason: input.stopReason ?? null,
    errorMessage: input.errorMessage ?? null,
    payloadJson,
    tokenInput: input.usage?.input ?? null,
    tokenOutput: input.usage?.output ?? null,
    tokenCacheRead: input.usage?.cacheRead ?? null,
    tokenCacheWrite: input.usage?.cacheWrite ?? null,
    tokenTotal: input.usage?.totalTokens ?? null,
    usageJson: input.usage == null ? null : JSON.stringify(input.usage),
    createdAt: input.createdAt.toISOString(),
  };
}

function shouldRetrySuccessfulEmptyAssistantOutput(input: {
  assistantText: string;
  reasoningText: string;
  toolCallsRequested: number;
  sawStreamedText: boolean;
  sawStreamedReasoning: boolean;
  retryCount: number;
}): boolean {
  if (
    input.retryCount >= EMPTY_OUTPUT_LLM_RETRY_LIMIT ||
    input.sawStreamedText ||
    input.sawStreamedReasoning
  ) {
    return false;
  }

  return (
    input.assistantText.length === 0 &&
    input.reasoningText.length === 0 &&
    input.toolCallsRequested === 0
  );
}

function getRetryableLlmFailureWithoutVisibleOutput(input: {
  error: unknown;
  sawStreamedText: boolean;
  sawStreamedReasoning: boolean;
  retryCount: number;
}): import("@/src/agent/llm/errors.js").AgentLlmError | null {
  if (
    input.retryCount >= EMPTY_OUTPUT_LLM_RETRY_LIMIT ||
    !isAgentLlmError(input.error) ||
    !input.error.retryable ||
    input.sawStreamedText ||
    input.sawStreamedReasoning
  ) {
    return null;
  }

  return input.error;
}

function appendPartialStreamedAssistantMessageOnFailure(input: {
  repo: MessagesRepo;
  sessionId: string;
  messageId: string;
  nextSeq: number;
  appendedMessageIds: string[];
  messages: Message[];
  turn: number;
  runId: string;
  conversationId: string;
  branchId: string;
  modelId: string;
  providerId: string;
  modelApi: string;
  text: string;
  reasoningText: string;
  errorMessage: string;
  recordEvent: (event: AgentRuntimeEventInput) => void;
}): number {
  const content: AgentAssistantContentBlock[] = [];
  if (input.reasoningText.trim().length > 0) {
    content.push({
      type: "thinking",
      thinking: input.reasoningText,
    });
  }
  if (input.text.length > 0) {
    content.push({
      type: "text",
      text: input.text,
    });
  }

  if (content.length === 0) {
    return input.nextSeq;
  }

  const assistantMessage = appendMessageAndHydrate({
    repo: input.repo,
    sessionId: input.sessionId,
    messageId: input.messageId,
    seq: input.nextSeq,
    role: "assistant",
    messageType: "text",
    visibility: "user_visible",
    provider: input.providerId,
    model: input.modelId,
    modelApi: input.modelApi,
    stopReason: "error",
    errorMessage: input.errorMessage,
    payload: {
      content,
    } satisfies AgentAssistantPayload,
    usage: UNKNOWN_ASSISTANT_ERROR_USAGE,
    createdAt: new Date(),
  });
  input.messages.push(assistantMessage);
  input.appendedMessageIds.push(input.messageId);
  input.recordEvent({
    type: "assistant_message_completed",
    turn: input.turn,
    messageId: input.messageId,
    text: input.text,
    reasoningText: input.reasoningText.trim().length > 0 ? input.reasoningText : null,
    toolCalls: [],
    usage: null,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    runId: input.runId,
  });
  return assistantMessage.seq + 1;
}

function isMessageSeqUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) {
    return false;
  }
  const maybeCode = "code" in error ? error.code : undefined;
  if (maybeCode === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  const maybeMessage = "message" in error ? error.message : undefined;
  return (
    typeof maybeMessage === "string" &&
    maybeMessage.includes("UNIQUE constraint failed: messages.session_id, messages.seq")
  );
}

function collectAssistantText(content: AgentAssistantContentBlock[]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function collectAssistantThinking(content: AgentAssistantContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
    .join("\n")
    .trim();
}

function assertSessionModelSupportsTools(input: {
  sessionPurpose: string;
  scenario: ModelScenario;
  model: ResolvedModel;
}): void {
  if (input.model.supportsTools) {
    return;
  }

  if (input.sessionPurpose !== "task" && input.sessionPurpose !== "approval") {
    return;
  }

  throw new Error(
    `Session purpose "${input.sessionPurpose}" requires a tool-capable model, but scenario "${input.scenario}" resolved to "${input.model.id}" with supportsTools=false.`,
  );
}

function collectAgentToolCalls(content: AgentAssistantContentBlock[]): AgentToolCall[] {
  return content.flatMap((block) =>
    block.type === "toolCall"
      ? [
          {
            id: block.id,
            name: block.name,
            args: block.arguments,
          } satisfies AgentToolCall,
        ]
      : [],
  );
}

function findAssistantToolCallById(messages: Message[], toolCallId: string): AgentToolCall | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const payload = safeParsePayload<AgentAssistantPayload>(message.payloadJson);
    if (!Array.isArray(payload?.content)) {
      continue;
    }

    const toolCall = collectAgentToolCalls(payload.content).find(
      (entry) => entry.id === toolCallId,
    );
    if (toolCall != null) {
      return toolCall;
    }
  }

  return null;
}

function summarizeTranscriptTail(messages: Message[], maxMessages: number = 6) {
  const summary = messages.slice(-maxMessages).map((message) => {
    if (message.role === "user") {
      const payload = safeParsePayload<{ content?: unknown }>(message.payloadJson);
      const content =
        typeof payload?.content === "string" ? truncateLogText(payload.content, 24) : "non-text";
      return `u:${content}`;
    }

    if (message.role === "tool") {
      const payload = safeParsePayload<{
        toolName?: unknown;
        toolCallId?: unknown;
        isError?: unknown;
      }>(message.payloadJson);
      const toolName = typeof payload?.toolName === "string" ? payload.toolName : "unknown";
      return payload?.isError === true ? `t:${toolName}:err` : `t:${toolName}`;
    }

    const payload = safeParsePayload<{ content?: Array<{ type?: string; text?: string }> }>(
      message.payloadJson,
    );
    const text = Array.isArray(payload?.content)
      ? payload.content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join(" ")
      : "";
    const stopReason = message.stopReason ?? "?";
    const summaryText = text.length > 0 ? `:${truncateLogText(text, 16)}` : "";
    return `a:${stopReason}${summaryText}`;
  });

  return truncateLogText(summary.join(">"), 72);
}

function safeParsePayload<T>(payloadJson: string): T | null {
  try {
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}

function truncateLogText(text: string, maxLength: number = 80) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(typeof reason === "string" ? reason : "Operation aborted");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

function isCompactionModelRunner(
  runner: AgentModelRunner,
): runner is AgentModelRunner & CompactionModelRunner {
  return "runCompaction" in runner && typeof runner.runCompaction === "function";
}

class AgentLoopTurnLimitError extends Error {
  constructor(readonly maxTurns: number) {
    super(`Run hit the configured max turn limit (${maxTurns}) before producing a final response.`);
    this.name = "AgentLoopTurnLimitError";
  }
}

function toRunFailure(error: unknown): {
  kind:
    | import("@/src/agent/llm/errors.js").AgentLlmErrorKind
    | import("@/src/tools/core/errors.js").ToolFailureKind
    | "unknown";
  message: string;
  rawMessage?: string | null;
  retryable: boolean;
} {
  if (isAgentLlmError(error)) {
    return {
      kind: error.kind,
      message: error.message,
      rawMessage: error.rawMessage ?? null,
      retryable: error.retryable,
    };
  }

  if (isToolFailure(error)) {
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof AgentLoopTurnLimitError) {
    return {
      kind: "unknown",
      message: error.message,
      retryable: false,
    };
  }

  return {
    kind: "unknown",
    message: getErrorMessage(error),
    retryable: false,
  };
}
