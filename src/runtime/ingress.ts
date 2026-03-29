/**
 * Unified runtime ingress API.
 *
 * Channel adapters and orchestration submit user messages, steering inputs,
 * and approval decisions through this boundary. Ingress delegates scheduling
 * and ordering to dispatcher/session-lane primitives.
 */
import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import {
  InMemorySessionDispatcher,
  type SubmitSessionMessageInput,
  type SubmitSessionMessageResult,
} from "@/src/runtime/dispatcher.js";
import type { SessionLaneDependencies } from "@/src/runtime/session-lane.js";

// Runtime ingress is the transport-facing entrypoint for a session.
// External callers only submit semantic inputs such as a user message or an
// approval decision. They do not decide whether a message is a fresh turn or a
// steer; that stays inside the per-session lane.
export interface SessionRuntimeIngressDependencies extends SessionLaneDependencies {}

export type SubmitMessageInput = SubmitSessionMessageInput;
export type SubmitMessageResult = SubmitSessionMessageResult;

export class SessionRuntimeIngress {
  private readonly dispatcher: InMemorySessionDispatcher;

  constructor(deps: SessionRuntimeIngressDependencies) {
    this.dispatcher = new InMemorySessionDispatcher(deps);
  }

  // Unified message ingress. The dispatcher/lane will decide whether this
  // starts a new run or gets queued behind the current run as steer.
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult> {
    return this.dispatcher.submitMessage(input);
  }

  // Approval decisions are a distinct ingress command type. They target a
  // pending approval wait instead of becoming transcript messages.
  submitApprovalDecision(input: ApprovalResponseInput): boolean {
    return this.dispatcher.submitApprovalDecision(input);
  }

  isSessionActive(sessionId: string): boolean {
    return this.dispatcher.isSessionActive(sessionId);
  }
}
