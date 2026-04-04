/**
 * Runtime live observability model for active and recently finished runs.
 *
 * This module intentionally keeps the runtime-side telemetry lightweight,
 * in-memory, and query-oriented. It separates run-level lifecycle state from
 * request-level streaming state so multi-request runs remain diagnosable even
 * when the latest request has not emitted a first token yet.
 */

export type RunLivePhase =
  | "running"
  | "tool_running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type RunLiveRequestStatus =
  | "waiting_first_token"
  | "streaming"
  | "finished"
  | "failed"
  | "cancelled";

export interface RunLiveLatestRequestState {
  sequence: number;
  status: RunLiveRequestStatus;
  startedAt: Date;
  finishedAt: Date | null;
  firstTokenAt: Date | null;
  lastTokenAt: Date | null;
  outputChars: number;
  estimatedOutputTokens: number;
  finalOutputTokens: number | null;
  activeAssistantMessageId: string | null;
}

export interface RunLiveResponseSummaryState {
  requestCount: number;
  respondedRequestCount: number;
  firstResponseAt: Date | null;
  lastResponseAt: Date | null;
  lastRespondedRequestSequence: number | null;
  lastRespondedRequestTtftMs: number | null;
}

export interface RunLiveObservabilityState {
  runId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  scenario: string;
  phase: RunLivePhase | null;
  runStartedAt: Date | null;
  latestRequest: RunLiveLatestRequestState | null;
  responseSummary: RunLiveResponseSummaryState;
  activeToolCallId: string | null;
  activeToolName: string | null;
  waitingApprovalId: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
}

export interface RunLiveLatestRequestSnapshot {
  sequence: number;
  status: RunLiveRequestStatus;
  startedAt: string;
  finishedAt: string | null;
  firstTokenAt: string | null;
  lastTokenAt: string | null;
  ttftMs: number | null;
  timeSinceLastTokenMs: number | null;
  outputChars: number;
  estimatedOutputTokens: number;
  finalOutputTokens: number | null;
  avgCharsPerSecond: number | null;
  activeAssistantMessageId: string | null;
}

export interface RunLiveResponseSummarySnapshot {
  requestCount: number;
  respondedRequestCount: number;
  hasAnyResponse: boolean;
  firstResponseAt: string | null;
  lastResponseAt: string | null;
  lastRespondedRequestSequence: number | null;
  lastRespondedRequestTtftMs: number | null;
}

export interface RunLiveObservabilitySnapshot {
  runId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  scenario: string;
  phase: RunLivePhase | null;
  runStartedAt: string | null;
  timeSinceStartMs: number | null;
  latestRequest: RunLiveLatestRequestSnapshot | null;
  responseSummary: RunLiveResponseSummarySnapshot;
  activeToolCallId: string | null;
  activeToolName: string | null;
  waitingApprovalId: string | null;
}

export function createInitialRunLiveObservabilityState(input: {
  runId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  scenario: string;
}): RunLiveObservabilityState {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    scenario: input.scenario,
    phase: null,
    runStartedAt: null,
    latestRequest: null,
    responseSummary: {
      requestCount: 0,
      respondedRequestCount: 0,
      firstResponseAt: null,
      lastResponseAt: null,
      lastRespondedRequestSequence: null,
      lastRespondedRequestTtftMs: null,
    },
    activeToolCallId: null,
    activeToolName: null,
    waitingApprovalId: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
  };
}

export function estimateOutputTokensFromChars(outputChars: number): number {
  if (!Number.isFinite(outputChars) || outputChars <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(outputChars / 4));
}

/**
 * User-facing output stability metric.
 *
 * This intentionally uses visible character output instead of model-reported token
 * counts so the rate stays on one consistent, user-perceivable scale throughout
 * streaming and after completion.
 */
export function computeAverageCharsPerSecond(input: {
  firstTokenAt: Date | null;
  lastTokenAt: Date | null;
  outputChars: number;
}): number | null {
  if (input.firstTokenAt == null || input.lastTokenAt == null) {
    return null;
  }

  const durationMs = input.lastTokenAt.getTime() - input.firstTokenAt.getTime();
  if (durationMs <= 0 || input.outputChars <= 0) {
    return null;
  }

  return input.outputChars / (durationMs / 1000);
}

export function toRunLiveObservabilitySnapshot(
  state: RunLiveObservabilityState,
  now: Date,
): RunLiveObservabilitySnapshot {
  const latestRequest = state.latestRequest;

  return {
    runId: state.runId,
    sessionId: state.sessionId,
    conversationId: state.conversationId,
    branchId: state.branchId,
    scenario: state.scenario,
    phase: state.phase,
    runStartedAt: state.runStartedAt?.toISOString() ?? null,
    timeSinceStartMs:
      state.runStartedAt == null ? null : Math.max(0, now.getTime() - state.runStartedAt.getTime()),
    latestRequest:
      latestRequest == null
        ? null
        : {
            sequence: latestRequest.sequence,
            status: latestRequest.status,
            startedAt: latestRequest.startedAt.toISOString(),
            finishedAt: latestRequest.finishedAt?.toISOString() ?? null,
            firstTokenAt: latestRequest.firstTokenAt?.toISOString() ?? null,
            lastTokenAt: latestRequest.lastTokenAt?.toISOString() ?? null,
            ttftMs:
              latestRequest.firstTokenAt == null
                ? null
                : Math.max(
                    0,
                    latestRequest.firstTokenAt.getTime() - latestRequest.startedAt.getTime(),
                  ),
            timeSinceLastTokenMs:
              latestRequest.lastTokenAt == null
                ? null
                : Math.max(0, now.getTime() - latestRequest.lastTokenAt.getTime()),
            outputChars: latestRequest.outputChars,
            estimatedOutputTokens: latestRequest.estimatedOutputTokens,
            finalOutputTokens: latestRequest.finalOutputTokens,
            avgCharsPerSecond: computeAverageCharsPerSecond({
              firstTokenAt: latestRequest.firstTokenAt,
              lastTokenAt: latestRequest.lastTokenAt,
              outputChars: latestRequest.outputChars,
            }),
            activeAssistantMessageId: latestRequest.activeAssistantMessageId,
          },
    responseSummary: {
      requestCount: state.responseSummary.requestCount,
      respondedRequestCount: state.responseSummary.respondedRequestCount,
      hasAnyResponse: state.responseSummary.respondedRequestCount > 0,
      firstResponseAt: state.responseSummary.firstResponseAt?.toISOString() ?? null,
      lastResponseAt: state.responseSummary.lastResponseAt?.toISOString() ?? null,
      lastRespondedRequestSequence: state.responseSummary.lastRespondedRequestSequence,
      lastRespondedRequestTtftMs: state.responseSummary.lastRespondedRequestTtftMs,
    },
    activeToolCallId: state.activeToolCallId,
    activeToolName: state.activeToolName,
    waitingApprovalId: state.waitingApprovalId,
  };
}
