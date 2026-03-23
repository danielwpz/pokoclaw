import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import {
  InMemorySessionLane,
  type SessionLaneDependencies,
  type SubmitSessionMessageInput,
  type SubmitSessionMessageResult,
} from "@/src/runtime/session-lane.js";

export type {
  SubmitSessionMessageInput,
  SubmitSessionMessageResult,
} from "@/src/runtime/session-lane.js";

// The dispatcher is the single-process registry of per-session lanes.
// In the current Node runtime we intentionally rely on synchronous map lookup
// and lane creation before the first await, so concurrent ingress for the same
// session collapses onto one in-memory lane instead of spawning multiple runs.
export class InMemorySessionDispatcher {
  private readonly lanes = new Map<string, InMemorySessionLane>();

  constructor(private readonly deps: SessionLaneDependencies) {}

  submitMessage(input: SubmitSessionMessageInput): Promise<SubmitSessionMessageResult> {
    return this.getOrCreateLane(input.sessionId).submitMessage(input);
  }

  // Approval decisions still go straight to the pending wait registry owned by
  // AgentLoop. This is enough for the current single-process hot path; if we
  // later unify all ingress commands into a single actor queue, this method is
  // the place to reroute them through the lane.
  submitApprovalDecision(input: ApprovalResponseInput): boolean {
    return this.deps.loop.submitApprovalResponse(input);
  }

  isSessionActive(sessionId: string): boolean {
    return this.getOrCreateLane(sessionId).isActive();
  }

  private getOrCreateLane(sessionId: string): InMemorySessionLane {
    const existing = this.lanes.get(sessionId);
    if (existing != null) {
      return existing;
    }

    const lane = new InMemorySessionLane(this.deps);
    this.lanes.set(sessionId, lane);
    return lane;
  }
}
