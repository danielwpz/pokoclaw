/**
 * In-memory per-session lane state machine.
 *
 * A lane serializes run execution and buffers steer inputs for one session.
 * This implementation assumes a single-process event loop and can be replaced
 * by external coordination if runtime becomes multi-process.
 */
import { randomUUID } from "node:crypto";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { AgentLoop, RunAgentLoopResult } from "@/src/agent/loop.js";
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
  messageType?: string;
  visibility?: string;
  createdAt?: Date;
  maxTurns?: number;
}

export type SubmitSessionMessageResult =
  | {
      status: "started";
      messageId: string;
      run: RunAgentLoopResult;
    }
  | {
      status: "steered";
    };

export interface SessionLaneDependencies {
  loop: AgentLoop;
  messages: MessagesRepo;
}

export class InMemorySessionLane {
  private activeRun: Promise<RunAgentLoopResult> | null = null;

  constructor(private readonly deps: SessionLaneDependencies) {}

  isActive(): boolean {
    return this.activeRun != null;
  }

  // If a run is already active, this message becomes steer and is handed to the
  // loop's steer queue. Otherwise we append it as a new user message and start
  // the session run immediately.
  async submitMessage(input: SubmitSessionMessageInput): Promise<SubmitSessionMessageResult> {
    if (this.activeRun != null) {
      const steered = this.deps.loop.enqueueSteerInput({
        sessionId: input.sessionId,
        content: input.content,
        ...(input.messageType == null ? {} : { messageType: input.messageType }),
        ...(input.visibility == null ? {} : { visibility: input.visibility }),
        ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
      });
      if (steered) {
        logger.info("queued inbound message behind active run", {
          sessionId: input.sessionId,
          content: truncateLogValue(input.content),
        });
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
      payloadJson: JSON.stringify({
        content: input.content,
      }),
      messageType: input.messageType ?? "text",
      visibility: input.visibility ?? "user_visible",
      createdAt: input.createdAt ?? new Date(),
    });

    const runPromise = this.deps.loop
      .run({
        sessionId: input.sessionId,
        scenario: input.scenario,
        ...(input.maxTurns == null ? {} : { maxTurns: input.maxTurns }),
      })
      .finally(() => {
        if (this.activeRun === runPromise) {
          this.activeRun = null;
          logger.debug("session run became idle", { sessionId: input.sessionId });
        }
      });

    this.activeRun = runPromise;
    logger.info("starting session run", {
      sessionId: input.sessionId,
      messageId,
      scenario: input.scenario,
    });

    return {
      status: "started",
      messageId,
      run: await runPromise,
    };
  }

  submitApprovalDecision(input: ApprovalResponseInput): boolean {
    return this.deps.loop.submitApprovalResponse(input);
  }
}

function truncateLogValue(value: string, maxLength: number = 40) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
