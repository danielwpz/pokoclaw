/**
 * In-memory per-session lane state machine.
 *
 * A lane serializes run execution and buffers steer inputs for one session.
 * This implementation assumes a single-process event loop and can be replaced
 * by external coordination if runtime becomes multi-process.
 */
import { randomUUID } from "node:crypto";
import {
  type AgentUserPayload,
  type AgentUserRuntimeImagePayload,
  normalizeAgentUserImageMessageId,
} from "@/src/agent/llm/messages.js";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type {
  AgentLoop,
  AgentLoopAfterToolResultHook,
  RunAgentLoopResult,
} from "@/src/agent/loop.js";
import type {
  ContextClearExecutionResult,
  ContextClearService,
} from "@/src/context-clear/service.js";
import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { MessagesRepo } from "@/src/storage/repos/messages.repo.js";

const logger = createSubsystemLogger("runtime-lane");

// A session lane owns the "one active run per session" invariant.
// The important implementation detail is that activeRun is claimed
// synchronously before the first await, which is why this lock-free design is
// safe in the current single-process Node event-loop model.
export interface SubmitSessionMessageInput {
  sessionId: string;
  scenario: ModelScenario;
  content: string;
  userPayload?: AgentUserPayload;
  runtimeImages?: AgentUserRuntimeImagePayload[];
  messageType?: string;
  visibility?: string;
  channelMessageId?: string | null;
  channelParentMessageId?: string | null;
  channelThreadId?: string | null;
  createdAt?: Date;
  // Called synchronously once the lane has durably persisted or queued the input.
  // The returned promise continues to track the resulting Agent run lifecycle.
  onAccepted?: () => void;
  maxTurns?: number;
  afterToolResultHook?: AgentLoopAfterToolResultHook;
}

export type SubmitSessionMessageResult =
  | {
      status: "started";
      messageId: string;
      run: RunAgentLoopResult;
    }
  | {
      status: "steered";
    }
  | {
      status: "queued";
      clearRunId: string;
    };

export interface SessionLaneDependencies {
  loop: AgentLoop;
  messages: MessagesRepo;
  contextClear?: ContextClearService;
}

export class InMemorySessionLane {
  private activeRun: Promise<RunAgentLoopResult> | null = null;
  private clearRunId: string | null = null;
  private clearPromise: Promise<ContextClearExecutionResult> | null = null;

  constructor(private readonly deps: SessionLaneDependencies) {}

  isActive(): boolean {
    return this.activeRun != null || this.clearPromise != null;
  }

  // If a run is already active, this message becomes steer and is handed to the
  // loop's steer queue. Otherwise we append it as a new user message and start
  // the session run immediately.
  async submitMessage(input: SubmitSessionMessageInput): Promise<SubmitSessionMessageResult> {
    const normalized = normalizeSubmittedUserPayload(input.userPayload, input.runtimeImages);
    logger.debug("session lane received message", {
      sessionId: input.sessionId,
      scenario: input.scenario,
      hasUserPayload: normalized.userPayload != null,
      persistedImageCount: normalized.userPayload?.images?.length ?? 0,
      runtimeImageCount: normalized.runtimeImages?.length ?? 0,
      runtimeImages: normalized.runtimeImages?.map((image) => ({
        id: image.id,
        messageId: image.messageId,
        mimeType: image.mimeType,
        byteLength: Buffer.from(image.data, "base64").length,
      })),
      channelMessageId: input.channelMessageId ?? null,
      channelParentMessageId: input.channelParentMessageId ?? null,
      channelThreadId: input.channelThreadId ?? null,
    });
    if (this.clearRunId != null) {
      if (input.afterToolResultHook != null) {
        throw new Error("Inputs with terminal tool hooks cannot be queued during context clear.");
      }
      const contextClear = this.requireContextClear();
      contextClear.enqueue({
        clearRunId: this.clearRunId,
        sessionId: input.sessionId,
        scenario: input.scenario,
        content: input.content,
        ...(normalized.userPayload == null ? {} : { userPayload: normalized.userPayload }),
        ...(normalized.runtimeImages == null ? {} : { runtimeImages: normalized.runtimeImages }),
        ...(input.messageType == null ? {} : { messageType: input.messageType }),
        ...(input.visibility == null ? {} : { visibility: input.visibility }),
        ...(input.channelMessageId === undefined
          ? {}
          : { channelMessageId: input.channelMessageId ?? null }),
        ...(input.channelParentMessageId === undefined
          ? {}
          : { channelParentMessageId: input.channelParentMessageId ?? null }),
        ...(input.channelThreadId === undefined
          ? {}
          : { channelThreadId: input.channelThreadId ?? null }),
        ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
        ...(input.maxTurns == null ? {} : { maxTurns: input.maxTurns }),
      });
      notifySubmissionAccepted(input);
      logger.info("durably queued session message during context clear", {
        sessionId: input.sessionId,
        clearRunId: this.clearRunId,
        scenario: input.scenario,
      });
      return { status: "queued", clearRunId: this.clearRunId };
    }
    if (this.activeRun != null) {
      const steered = this.deps.loop.enqueueSteerInput({
        sessionId: input.sessionId,
        content: input.content,
        ...(normalized.userPayload == null ? {} : { userPayload: normalized.userPayload }),
        ...(normalized.runtimeImages == null ? {} : { runtimeImages: normalized.runtimeImages }),
        ...(input.messageType == null ? {} : { messageType: input.messageType }),
        ...(input.visibility == null ? {} : { visibility: input.visibility }),
        ...(input.channelMessageId === undefined
          ? {}
          : { channelMessageId: input.channelMessageId ?? null }),
        ...(input.channelParentMessageId === undefined
          ? {}
          : { channelParentMessageId: input.channelParentMessageId ?? null }),
        ...(input.channelThreadId === undefined
          ? {}
          : { channelThreadId: input.channelThreadId ?? null }),
        ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
      });
      if (steered) {
        logger.debug("queued inbound message behind active session run", {
          sessionId: input.sessionId,
          scenario: input.scenario,
          content: truncateLogValue(input.content),
          persistedImageCount: normalized.userPayload?.images?.length ?? 0,
          runtimeImageCount: normalized.runtimeImages?.length ?? 0,
        });
        notifySubmissionAccepted(input);
        return {
          status: "steered",
        };
      }
    }

    const messageId = randomUUID();
    this.deps.messages.append({
      id: messageId,
      sessionId: input.sessionId,
      seq: this.deps.messages.getNextSeq(input.sessionId),
      role: "user",
      payloadJson: JSON.stringify(
        normalized.userPayload ?? {
          content: input.content,
        },
      ),
      messageType: input.messageType ?? "text",
      visibility: input.visibility ?? "user_visible",
      channelMessageId: input.channelMessageId ?? null,
      channelParentMessageId: input.channelParentMessageId ?? null,
      channelThreadId: input.channelThreadId ?? null,
      createdAt: input.createdAt ?? new Date(),
    });

    notifySubmissionAccepted(input);

    const runPromise = this.startPersistedRun({
      sessionId: input.sessionId,
      scenario: input.scenario,
      ...(normalized.runtimeImages == null || normalized.runtimeImages.length === 0
        ? {}
        : { initialRuntimeImagesByMessageId: { [messageId]: normalized.runtimeImages } }),
      ...(input.maxTurns == null ? {} : { maxTurns: input.maxTurns }),
      ...(input.afterToolResultHook == null
        ? {}
        : { afterToolResultHook: input.afterToolResultHook }),
    });

    logger.debug("starting session run", {
      sessionId: input.sessionId,
      messageId,
      scenario: input.scenario,
      persistedImageCount: normalized.userPayload?.images?.length ?? 0,
      runtimeImageCount: normalized.runtimeImages?.length ?? 0,
      runtimeImageMessageIds: normalized.runtimeImages?.map((image) => image.messageId) ?? [],
    });

    return {
      status: "started",
      messageId,
      run: await runPromise,
    };
  }

  clearContext(
    sessionId: string,
    requestKey?: string | null,
  ): Promise<ContextClearExecutionResult> {
    if (this.clearPromise != null) {
      return this.clearPromise;
    }
    const contextClear = this.requireContextClear();
    const requested = contextClear.request(sessionId, requestKey);
    if (requested.status === "completed" || requested.status === "failed") {
      return contextClear.execute(requested.id);
    }
    this.clearRunId = requested.id;
    const clearPromise = this.performContextClear({
      sessionId,
      clearRunId: requested.id,
      activeRunAtRequest: this.activeRun,
    });
    this.clearPromise = clearPromise;
    return clearPromise;
  }

  resumeDrainedInputs(inputs: ContextClearExecutionResult["drainedInputs"]): void {
    if (inputs.length === 0) {
      return;
    }
    if (this.activeRun != null || this.clearPromise != null) {
      throw new Error(
        `Cannot resume persisted input while session ${inputs[0]?.sessionId} is active.`,
      );
    }
    this.startDrainedInputs(inputs);
  }

  private async performContextClear(input: {
    sessionId: string;
    clearRunId: string;
    activeRunAtRequest: Promise<RunAgentLoopResult> | null;
  }): Promise<ContextClearExecutionResult> {
    if (input.activeRunAtRequest != null) {
      await input.activeRunAtRequest.catch(() => undefined);
    }
    let result: ContextClearExecutionResult;
    try {
      result = await this.requireContextClear().execute(input.clearRunId);
    } finally {
      if (this.clearRunId === input.clearRunId) {
        this.clearRunId = null;
        this.clearPromise = null;
      }
    }
    this.startDrainedInputs(result.drainedInputs);
    return result;
  }

  private startDrainedInputs(inputs: ContextClearExecutionResult["drainedInputs"]): void {
    const first = inputs[0];
    if (first == null) {
      return;
    }
    const runtimeImagesByMessageId = Object.fromEntries(
      inputs
        .filter((entry) => entry.runtimeImages.length > 0)
        .map((entry) => [entry.messageId, entry.runtimeImages]),
    );
    const runPromise = this.startPersistedRun({
      sessionId: first.sessionId,
      scenario: first.scenario,
      ...(Object.keys(runtimeImagesByMessageId).length === 0
        ? {}
        : { initialRuntimeImagesByMessageId: runtimeImagesByMessageId }),
      ...(first.maxTurns == null ? {} : { maxTurns: first.maxTurns }),
    });
    void runPromise.catch(() => undefined);
  }

  private startPersistedRun(input: {
    sessionId: string;
    scenario: ModelScenario;
    initialRuntimeImagesByMessageId?: Record<string, AgentUserRuntimeImagePayload[]>;
    maxTurns?: number;
    afterToolResultHook?: AgentLoopAfterToolResultHook;
  }): Promise<RunAgentLoopResult> {
    const runPromise = this.deps.loop
      .run(input)
      .then((run) => {
        logger.debug("session lane run resolved", {
          sessionId: input.sessionId,
          scenario: input.scenario,
          runId: run.runId,
          appendedMessages: run.appendedMessageIds.length,
          toolExecutions: run.toolExecutions,
          stopSignalReason: run.stopSignal?.reason ?? null,
        });
        return run;
      })
      .catch((error: unknown) => {
        logger.error("session lane run rejected", {
          sessionId: input.sessionId,
          scenario: input.scenario,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        if (this.activeRun === runPromise) {
          this.activeRun = null;
          logger.debug("session run became idle", {
            sessionId: input.sessionId,
            scenario: input.scenario,
          });
        }
      });

    this.activeRun = runPromise;
    return runPromise;
  }

  submitApprovalDecision(input: ApprovalResponseInput): boolean {
    return this.deps.loop.submitApprovalResponse(input);
  }

  private requireContextClear(): ContextClearService {
    if (this.deps.contextClear == null) {
      throw new Error("Context clear service is not configured.");
    }
    return this.deps.contextClear;
  }
}

function notifySubmissionAccepted(input: SubmitSessionMessageInput): void {
  try {
    input.onAccepted?.();
  } catch (error) {
    logger.error("session message acceptance callback failed", {
      sessionId: input.sessionId,
      scenario: input.scenario,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeSubmittedUserPayload(
  userPayload: AgentUserPayload | undefined,
  runtimeImages: AgentUserRuntimeImagePayload[] | undefined,
): {
  userPayload: AgentUserPayload | undefined;
  runtimeImages: AgentUserRuntimeImagePayload[] | undefined;
} {
  if (userPayload == null || !Array.isArray(userPayload.images)) {
    logger.debug("normalizeSubmittedUserPayload bypassed image normalization", {
      hasUserPayload: userPayload != null,
      runtimeImageCount: runtimeImages?.length ?? 0,
    });
    return { userPayload, runtimeImages };
  }

  const existingRuntimeImages = runtimeImages ?? [];
  const extractedRuntimeImages: AgentUserRuntimeImagePayload[] = [];
  const normalizedImages = userPayload.images.flatMap((image) => {
    if (image?.type !== "image" || typeof image.id !== "string" || image.id.length === 0) {
      return [];
    }
    const runtimeCandidate = image as AgentUserRuntimeImagePayload;
    const messageId = normalizeAgentUserImageMessageId(
      runtimeCandidate.id,
      runtimeCandidate.messageId,
    );
    if (typeof runtimeCandidate.mimeType !== "string" || runtimeCandidate.mimeType.length === 0) {
      return [];
    }
    if (typeof runtimeCandidate.data === "string" && runtimeCandidate.data.length > 0) {
      extractedRuntimeImages.push({
        type: "image",
        id: runtimeCandidate.id,
        messageId,
        data: runtimeCandidate.data,
        mimeType: runtimeCandidate.mimeType,
      });
    }
    return [
      {
        type: "image" as const,
        id: runtimeCandidate.id,
        messageId,
        mimeType: runtimeCandidate.mimeType,
      },
    ];
  });

  const resolvedRuntimeImages =
    existingRuntimeImages.length > 0
      ? existingRuntimeImages
      : extractedRuntimeImages.length > 0
        ? extractedRuntimeImages
        : undefined;

  logger.debug("normalized submitted user payload images", {
    persistedImageCountBefore: userPayload.images.length,
    persistedImageCountAfter: normalizedImages.length,
    providedRuntimeImageCount: existingRuntimeImages.length,
    extractedLegacyRuntimeImageCount: extractedRuntimeImages.length,
    resolvedRuntimeImageCount: resolvedRuntimeImages?.length ?? 0,
    resolvedRuntimeImages: resolvedRuntimeImages?.map((image) => ({
      id: image.id,
      messageId: image.messageId,
      mimeType: image.mimeType,
      byteLength: Buffer.from(image.data, "base64").length,
    })),
  });

  return {
    userPayload: {
      ...userPayload,
      images: normalizedImages,
    },
    runtimeImages: resolvedRuntimeImages,
  };
}

function truncateLogValue(value: string, maxLength: number = 40) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
