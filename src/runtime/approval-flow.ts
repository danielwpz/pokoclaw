import type { ApprovalTarget, ResolvedApprovalRoute } from "@/src/runtime/approval-routing.js";

export const DEFAULT_SESSION_USER_TIMEOUT_DELEGATE_THRESHOLD = 2;

export type SessionApprovalStrategy = "direct_user" | "user_then_delegate" | "direct_delegate";

export interface ResolvedSessionApprovalPlan {
  strategy: SessionApprovalStrategy;
  initialTarget: ApprovalTarget;
  fallbackTarget: ApprovalTarget | null;
  consecutiveUserTimeouts: number;
  route: ResolvedApprovalRoute;
}

export interface ApprovalFlowOutcomeInput {
  actor: string;
  rawInput: string | null;
  grantedBy: "user" | "main_agent" | null;
}

export class SessionApprovalFlowRegistry {
  private readonly consecutiveUserTimeoutsBySessionId = new Map<string, number>();

  constructor(
    private readonly delegateThreshold: number = DEFAULT_SESSION_USER_TIMEOUT_DELEGATE_THRESHOLD,
  ) {}

  resolvePlan(input: {
    sessionId: string;
    route: ResolvedApprovalRoute;
  }): ResolvedSessionApprovalPlan {
    const consecutiveUserTimeouts = this.getConsecutiveUserTimeouts(input.sessionId);
    const supportsDelegateApproval = input.route.target === "main_agent";

    if (!supportsDelegateApproval) {
      return {
        strategy: "direct_user",
        initialTarget: "user",
        fallbackTarget: null,
        consecutiveUserTimeouts,
        route: input.route,
      };
    }

    if (consecutiveUserTimeouts >= this.delegateThreshold) {
      return {
        strategy: "direct_delegate",
        initialTarget: "main_agent",
        fallbackTarget: null,
        consecutiveUserTimeouts,
        route: input.route,
      };
    }

    return {
      strategy: "user_then_delegate",
      initialTarget: "user",
      fallbackTarget: "main_agent",
      consecutiveUserTimeouts,
      route: input.route,
    };
  }

  recordUserTimeout(sessionId: string): number {
    const next = this.getConsecutiveUserTimeouts(sessionId) + 1;
    this.consecutiveUserTimeoutsBySessionId.set(sessionId, next);
    return next;
  }

  resetUserTimeouts(sessionId: string): void {
    this.consecutiveUserTimeoutsBySessionId.delete(sessionId);
  }

  getConsecutiveUserTimeouts(sessionId: string): number {
    return this.consecutiveUserTimeoutsBySessionId.get(sessionId) ?? 0;
  }
}

export function isUserApprovalTimeoutOutcome(input: ApprovalFlowOutcomeInput): boolean {
  return input.actor === "system:timeout";
}

export function isExplicitUserApprovalDecision(input: ApprovalFlowOutcomeInput): boolean {
  if (input.grantedBy === "user") {
    return true;
  }

  if (input.actor === "user:intervention") {
    return false;
  }

  if (input.actor.startsWith("system:") || input.actor.startsWith("main_agent:")) {
    return false;
  }

  return (
    input.rawInput === "approve" ||
    input.rawInput === "approve_1d" ||
    input.rawInput === "approve_permanent" ||
    input.rawInput === "deny"
  );
}
