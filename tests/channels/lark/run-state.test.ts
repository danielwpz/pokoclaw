import { describe, expect, test } from "vitest";
import { buildLarkRenderedRunCard, renderLarkRunCard } from "@/src/channels/lark/render.js";
import {
  LARK_ASSISTANT_PLACEHOLDER_TEXT,
  reduceLarkRunState,
} from "@/src/channels/lark/run-state.js";
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

describe("lark run state", () => {
  test("keeps assistant/tool blocks in actual transcript order once visible text resumes", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_1",
        createdAt: "2026-03-28T00:00:00.000Z",
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
        type: "assistant_message_delta",
        eventId: "evt_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "hello",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_4",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_1",
        toolName: "grep",
        args: { query: "auth" },
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_completed",
        eventId: "evt_5",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_1",
        toolName: "grep",
        messageId: "tool_result_1",
        result: { content: [{ type: "text", text: "found" }] },
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_6",
        createdAt: "2026-03-28T00:00:05.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
      }),
    );
    expect(state.blocks.map((block) => block.kind)).toEqual(["assistant_text", "tool_sequence"]);

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_7b",
        createdAt: "2026-03-28T00:00:05.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
        delta: "done",
        accumulatedText: "done",
      }),
    );

    expect(state.blocks.map((block) => block.kind)).toEqual([
      "assistant_text",
      "tool_sequence",
      "assistant_text",
    ]);
  });

  test("does not split a tool sequence on assistant turns with no visible text", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_ns_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_1",
        toolName: "bash",
        args: { command: 'python3 -c "print(3**5)"' },
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_completed",
        eventId: "evt_ns_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_1",
        toolName: "bash",
        messageId: "tool_msg_1",
        result: { ok: true },
      } as never),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_ns_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_hidden",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_ns_4",
        createdAt: "2026-03-28T00:00:02.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_hidden",
        text: "",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_ns_5",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 3,
        toolCallId: "tool_2",
        toolName: "bash",
        args: { command: 'python3 -c "print(5**5)"' },
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_completed",
        eventId: "evt_ns_6",
        createdAt: "2026-03-28T00:00:03.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 3,
        toolCallId: "tool_2",
        toolName: "bash",
        messageId: "tool_msg_2",
        result: { ok: true },
      } as never),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_ns_7",
        createdAt: "2026-03-28T00:00:04.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 4,
        messageId: "msg_visible",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_ns_8",
        createdAt: "2026-03-28T00:00:04.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 4,
        messageId: "msg_visible",
        delta: "done",
        accumulatedText: "done",
      }),
    );

    expect(state.blocks.map((block) => block.kind)).toEqual(["tool_sequence", "assistant_text"]);
    const toolSequence = state.blocks[0];
    expect(toolSequence?.kind).toBe("tool_sequence");
    if (toolSequence?.kind === "tool_sequence") {
      expect(toolSequence.tools).toHaveLength(2);
      expect(toolSequence.finalized).toBe(true);
    }
  });

  test("collapses a finalized tool sequence only when it has more than two tools", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_1",
        toolName: "grep",
        args: { query: "auth" },
      }),
    );
    for (const index of [1, 2, 3]) {
      state = reduceLarkRunState(
        state,
        makeEnvelope({
          type: "tool_call_completed",
          eventId: `evt_complete_${index}`,
          createdAt: "2026-03-28T00:00:01.000Z",
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          runId: "run_1",
          turn: 1,
          toolCallId: `tool_${index}`,
          toolName: index === 1 ? "grep" : "read_file",
          messageId: `tool_msg_${index}`,
          result: { ok: true },
        } as never),
      );
      if (index < 3) {
        state = reduceLarkRunState(
          state,
          makeEnvelope({
            type: "tool_call_started",
            eventId: `evt_start_${index + 1}`,
            createdAt: "2026-03-28T00:00:01.500Z",
            sessionId: "sess_1",
            conversationId: "conv_1",
            branchId: "branch_1",
            runId: "run_1",
            turn: 1,
            toolCallId: `tool_${index + 1}`,
            toolName: "read_file",
            args: { path: `file_${index}` },
          }),
        );
      }
    }
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_7",
        createdAt: "2026-03-28T00:00:06.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_7b",
        createdAt: "2026-03-28T00:00:06.500Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
        delta: "done",
        accumulatedText: "done",
      }),
    );

    const card = renderLarkRunCard(state);
    const elements = ((card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      elements.some(
        (element) =>
          element.tag === "collapsible_panel" &&
          JSON.stringify(element.header).includes("个工具调用"),
      ),
    ).toBe(true);
  });

  test("appends completed reasoning into the shared top reasoning area", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_reason_start_1",
        createdAt: "2026-03-28T00:00:00.000Z",
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
        type: "assistant_message_completed",
        eventId: "evt_reason_done_1",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "first answer",
        reasoningText: "first reasoning",
        toolCalls: [],
        usage: null,
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_reason_start_2",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_reason_done_2",
        createdAt: "2026-03-28T00:00:03.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 2,
        messageId: "msg_2",
        text: "second answer",
        reasoningText: "second reasoning",
        toolCalls: [],
        usage: null,
      }),
    );

    expect(state.reasoning).toMatchObject({
      content: "first reasoning\n\nsecond reasoning",
      active: false,
      expanded: false,
    });

    const card = renderLarkRunCard(state);
    const elements = ((card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      elements.some(
        (element) =>
          element.tag === "collapsible_panel" &&
          JSON.stringify(element.header).includes("思考完成"),
      ),
    ).toBe(true);
  });

  test("does not render an empty reasoning block when no reasoning text exists", () => {
    const state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_no_reason_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );

    const card = renderLarkRunCard(state);
    const elements = ((card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      elements.some(
        (element) =>
          element.tag === "collapsible_panel" && JSON.stringify(element.header).includes("思考"),
      ),
    ).toBe(false);
  });

  test("renders stop button while running and removes it after completion", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_stop_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    let card = renderLarkRunCard(state);
    let elements = ((card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(elements.some((element) => element.tag === "button")).toBe(true);

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "run_completed",
        eventId: "evt_stop_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        appendedMessageIds: ["msg_1"],
        toolExecutions: 0,
        compactionRequested: false,
      }),
    );

    card = renderLarkRunCard(state);
    elements = ((card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(elements.some((element) => element.tag === "button")).toBe(false);
  });

  test("renders a placeholder before the first assistant delta and replaces it once text starts streaming", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_placeholder_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );

    let rendered = buildLarkRenderedRunCard(state);
    let elements = ((rendered.card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(elements.some((element) => element.content === LARK_ASSISTANT_PLACEHOLDER_TEXT)).toBe(
      true,
    );
    expect(rendered.card.config).toMatchObject({
      summary: { content: "正在思考" },
    });

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_placeholder_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    rendered = buildLarkRenderedRunCard(state);
    elements = ((rendered.card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    expect(elements.some((element) => element.content === LARK_ASSISTANT_PLACEHOLDER_TEXT)).toBe(
      false,
    );
    expect(elements.some((element) => element.content === "hello")).toBe(true);
    expect(rendered.card.config).toMatchObject({
      summary: { content: "正在输出内容" },
    });
  });

  test("renders bash tool details with command-first summary and structured stdout", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_bash_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_bash_1",
        toolName: "bash",
        args: {
          command: "date '+%Y-%m-%d %H:%M:%S %Z (%A)'",
          cwd: ".",
          timeoutMs: 10000,
        },
      }),
    );
    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "tool_call_completed",
        eventId: "evt_bash_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_bash_1",
        toolName: "bash",
        messageId: "tool_msg_1",
        result: {
          content: [
            {
              type: "text",
              text: "<bash_result>\n  <stdout>\n    2026-03-28 10:05:25 CST (Saturday)\n  </stdout>\n\n  <stderr>\n  </stderr>\n</bash_result>",
            },
          ],
          details: {
            command: "date '+%Y-%m-%d %H:%M:%S %Z (%A)'",
            cwd: "/Users/daniel/.pokeclaw/workspace",
            timeoutMs: 10000,
            exitCode: 0,
            signal: null,
          },
        },
      }),
    );

    const card = renderLarkRunCard(state);
    const elements = ((card.body as { elements: unknown[] }).elements ?? []) as Array<
      Record<string, unknown>
    >;
    const toolPanel = elements.find((element) => element.tag === "collapsible_panel");
    expect(JSON.stringify(toolPanel)).toContain("date '+%Y-%m-%d %H:%M:%S %Z (%A)'");
    expect(JSON.stringify(toolPanel)).toContain("**Command**");
    expect(JSON.stringify(toolPanel)).toContain("**Stdout**");
    expect(JSON.stringify(toolPanel)).not.toContain('"content": [');
  });
});
