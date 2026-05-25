import { describe, expect, test } from "vitest";
import { buildLarkRenderedRunCard } from "@/src/channels/lark/render.js";
import { reduceLarkRunState } from "@/src/channels/lark/run-state.js";
import type { OrchestratedRuntimeEventEnvelope } from "@/src/orchestration/outbound-events.js";

function makeEnvelope(
  event: OrchestratedRuntimeEventEnvelope["event"],
): OrchestratedRuntimeEventEnvelope {
  return {
    kind: "runtime_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_1",
      purpose: "chat",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: null,
      runType: null,
      status: null,
      executionSessionId: null,
    },
    run: {
      runId: "run_1",
    },
    object: {
      messageId: null,
      toolCallId: null,
      toolName: null,
      approvalId: null,
    },
    event,
  };
}

function getCardBodyElements(card: Record<string, unknown>): Record<string, unknown>[] {
  const body = isRecord(card.body) ? card.body : null;
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  return elements.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

describe("lark retry footer", () => {
  test("renders assistant response retry progress until visible model progress resumes", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_started",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_response_retrying",
        eventId: "evt_retry",
        createdAt: "2026-03-28T00:00:46.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        attempt: 2,
        maxAttempts: 5,
        reason: "llm_failure_without_visible_output",
        errorKind: "timeout",
        errorMessage: "LLM first response timed out",
        rawErrorMessage: null,
      }),
    );

    let rendered = buildLarkRenderedRunCard(state);
    expect(rendered.card).toMatchObject({
      config: {
        summary: {
          content: "🔁 模型响应超时，正在重试 2/5",
        },
      },
    });
    expect(getCardBodyElements(rendered.card)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "markdown",
          content: "🔁 模型响应超时，正在重试 2/5",
          text_size: "notation",
        }),
      ]),
    );

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_retry_started",
        createdAt: "2026-03-28T00:00:47.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    rendered = buildLarkRenderedRunCard(state);
    expect(getCardBodyElements(rendered.card)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "🔁 模型响应超时，正在重试 2/5",
        }),
      ]),
    );

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_reasoning_delta",
        eventId: "evt_reasoning",
        createdAt: "2026-03-28T00:00:48.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "Now thinking.",
      }),
    );
    rendered = buildLarkRenderedRunCard(state);
    const bodyJson = JSON.stringify((rendered.card as { body?: unknown }).body ?? {});
    expect(bodyJson).not.toContain("正在重试");
    expect(bodyJson).toContain("🧠 正在思考");
  });
});
