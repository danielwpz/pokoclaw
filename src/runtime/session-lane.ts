import { randomUUID } from "node:crypto";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { AgentLoop, RunAgentLoopResult } from "@/src/agent/loop.js";
import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import type { MessagesRepo } from "@/src/storage/repos/messages.repo.js";

// A session lane owns the "one active run per session" invariant.
// The important implementation detail is that activeRun is claimed
// synchronously before the first await, which is why this lock-free design is
// safe in the current single-process Node event-loop model.
export interface SubmitSessionMessageInput {
  sessionId: string;
  scenario: ModelScenario;
  content: string;
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
  now?: () => Date;
  createId?: () => string;
}

export class InMemorySessionLane {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private activeRun: Promise<RunAgentLoopResult> | null = null;

  constructor(private readonly deps: SessionLaneDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? (() => randomUUID());
  }

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
        ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
      });
      if (steered) {
        return {
          status: "steered",
        };
      }
    }

    const messageId = this.createId();
    this.deps.messages.append({
      id: messageId,
      sessionId: input.sessionId,
      seq: this.deps.messages.getNextSeq(input.sessionId),
      role: "user",
      payloadJson: JSON.stringify({
        content: input.content,
      }),
      messageType: "text",
      visibility: "user_visible",
      createdAt: input.createdAt ?? this.now(),
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
        }
      });

    this.activeRun = runPromise;

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
