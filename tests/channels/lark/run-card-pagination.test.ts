import { describe, expect, test } from "vitest";
import {
  LARK_RUN_CARD_BYTE_BUDGET,
  LARK_RUN_CARD_NODE_BUDGET,
} from "@/src/channels/lark/render/run-card.js";
import { buildLarkRenderedRunCardPages } from "@/src/channels/lark/render.js";
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

function buildLongText(label: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) => `${label}-${index} ${"x".repeat(48)}`).join(
    "\n",
  );
}

function buildOversizedRunningState() {
  let state = reduceLarkRunState(
    null,
    makeEnvelope({
      type: "assistant_message_completed",
      eventId: "evt_intro",
      createdAt: "2026-03-28T00:00:00.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      turn: 1,
      messageId: "msg_intro",
      text: "Collecting the requested diagnostics now.",
      reasoningText: null,
      toolCalls: [],
      usage: null,
    }),
  );

  for (let index = 0; index < 16; index += 1) {
    const longText = buildLongText(`tool-${index}`, 16);
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_started",
        eventId: `evt_tool_start_${index}`,
        createdAt: `2026-03-28T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: `tool_${index}`,
        toolName: index % 2 === 0 ? "read" : "grep",
        args: {
          path: `/workspace/file_${index}.ts`,
          query: `needle-${index}`,
          options: {
            note: longText,
          },
        },
      }),
    );

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_completed",
        eventId: `evt_tool_done_${index}`,
        createdAt: `2026-03-28T00:01:${String(index + 1).padStart(2, "0")}.000Z`,
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: `tool_${index}`,
        toolName: index % 2 === 0 ? "read" : "grep",
        messageId: `tool_msg_${index}`,
        result: {
          content: [
            {
              type: "text",
              text: longText,
            },
          ],
          details: {
            stdout: longText,
            nested: {
              excerpt: longText,
            },
          },
        },
      }),
    );
  }

  state = reduceLarkRunState(
    state,
    makeEnvelope({
      type: "assistant_message_started",
      eventId: "evt_final_start",
      createdAt: "2026-03-28T00:02:00.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      turn: 2,
      messageId: "msg_final",
    }),
  );

  state = reduceLarkRunState(
    state,
    makeEnvelope({
      type: "assistant_reasoning_delta",
      eventId: "evt_reasoning",
      createdAt: "2026-03-28T00:02:01.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      turn: 2,
      messageId: "msg_final",
      delta: buildLongText("reasoning", 40),
    }),
  );

  return reduceLarkRunState(
    state,
    makeEnvelope({
      type: "assistant_message_delta",
      eventId: "evt_final_delta",
      createdAt: "2026-03-28T00:02:02.000Z",
      sessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      runId: "run_1",
      turn: 2,
      messageId: "msg_final",
      delta: buildLongText("assistant", 20),
      accumulatedText: buildLongText("assistant", 20),
    }),
  );
}

describe("lark run card pagination", () => {
  test("paginates oversized running cards and keeps the stop button on the last page only", () => {
    const pages = buildLarkRenderedRunCardPages(buildOversizedRunningState());

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.metrics.jsonBytes).toBeLessThanOrEqual(LARK_RUN_CARD_BYTE_BUDGET);
      expect(page.metrics.taggedNodes).toBeLessThanOrEqual(LARK_RUN_CARD_NODE_BUDGET);
    }

    for (const page of pages.slice(0, -1)) {
      expect(JSON.stringify(page.card)).not.toContain("stop_run");
    }
    expect(JSON.stringify(pages.at(-1)?.card ?? {})).toContain("stop_run");
  });

  test("renders only the reasoning tail on the first page", () => {
    const pages = buildLarkRenderedRunCardPages(buildOversizedRunningState());
    const firstPageText = JSON.stringify(pages[0]?.card ?? {});

    expect(firstPageText).not.toContain("reasoning-0");
    expect(firstPageText).toContain("reasoning-39");
  });
});
