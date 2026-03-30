import { describe, expect, test } from "vitest";
import { createLarkApprovalStateFromRequest } from "@/src/channels/lark/approval-state.js";
import {
  buildLarkRenderedApprovalCard,
  buildLarkRenderedRunCard,
  renderLarkRunCard,
} from "@/src/channels/lark/render.js";
import {
  LARK_ASSISTANT_PLACEHOLDER_TEXT,
  markLarkRunApprovalResolved,
  markLarkRunAwaitingApproval,
  reduceLarkRunState,
} from "@/src/channels/lark/run-state.js";
import type {
  OrchestratedRuntimeEventEnvelope,
  OrchestratedTaskRunEventEnvelope,
} from "@/src/orchestration/outbound-events.js";

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

function makeTaskRuntimeEnvelope(
  event: OrchestratedRuntimeEventEnvelope["event"],
): OrchestratedRuntimeEventEnvelope {
  return {
    kind: "runtime_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_task",
      purpose: "task",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: "task_1",
      runType: "cron",
      status: "running",
      executionSessionId: "sess_task",
    },
    run: {
      runId: "run_task_1",
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

function makeTaskEnvelope(
  event: OrchestratedTaskRunEventEnvelope["event"],
): OrchestratedTaskRunEventEnvelope {
  return {
    kind: "task_run_event",
    target: {
      conversationId: "conv_1",
      branchId: "branch_1",
    },
    session: {
      sessionId: "sess_task",
      purpose: "task",
    },
    agent: {
      ownerAgentId: "agent_1",
      ownerRole: "main",
      mainAgentId: "agent_1",
    },
    taskRun: {
      taskRunId: "task_1",
      runType: "cron",
      status: event.status,
      executionSessionId: "sess_task",
    },
    run: {
      runId: null,
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

function findFirstToolHeaderContent(card: Record<string, unknown>): string | null {
  const body = isRecord(card.body) ? card.body : null;
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  for (const element of elements) {
    if (!isRecord(element) || element.tag !== "collapsible_panel") {
      continue;
    }
    const header = isRecord(element.header) ? element.header : null;
    const title = isRecord(header?.title) ? header.title : null;
    return typeof title?.content === "string" ? title.content : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

describe("lark run state", () => {
  test("creates a task card from task lifecycle events before any transcript exists", () => {
    const state = reduceLarkRunState(
      null,
      makeTaskEnvelope({
        type: "task_run_started",
        taskRunId: "task_1",
        runType: "cron",
        status: "running",
        startedAt: "2026-03-28T00:00:00.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: "cron_1",
        executionSessionId: "sess_task",
      }),
    );

    const rendered = buildLarkRenderedRunCard(state);
    expect(state.taskRunId).toBe("task_1");
    expect(state.terminal).toBe("running");
    expect(rendered.card).toMatchObject({
      header: {
        title: {
          content: "定时任务运行中",
        },
        template: "blue",
      },
      config: {
        summary: {
          content: "定时任务运行中",
        },
      },
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "markdown",
            content: expect.stringContaining("任务已启动"),
          }),
        ]),
      },
    });
  });

  test("finalizes task cards from task lifecycle events instead of runtime terminal events", () => {
    let state = reduceLarkRunState(
      null,
      makeTaskEnvelope({
        type: "task_run_started",
        taskRunId: "task_1",
        runType: "cron",
        status: "running",
        startedAt: "2026-03-28T00:00:00.000Z",
        initiatorSessionId: null,
        parentRunId: null,
        cronJobId: "cron_1",
        executionSessionId: "sess_task",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeTaskRuntimeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_task_1",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_1",
      }),
    );
    state = reduceLarkRunState(
      state,
      makeTaskRuntimeEnvelope({
        type: "assistant_message_completed",
        eventId: "evt_task_2",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_task",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_task_1",
        turn: 1,
        messageId: "msg_1",
        text: "Working...",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );
    state = reduceLarkRunState(
      state,
      makeTaskEnvelope({
        type: "task_run_completed",
        taskRunId: "task_1",
        runType: "cron",
        status: "completed",
        startedAt: "2026-03-28T00:00:00.000Z",
        finishedAt: "2026-03-28T00:01:00.000Z",
        durationMs: 60_000,
        resultSummary: "Published the daily report successfully.",
        executionSessionId: "sess_task",
      }),
    );

    const rendered = buildLarkRenderedRunCard(state);
    expect(state.runId).toBe("run_task_1");
    expect(state.terminal).toBe("completed");
    expect(rendered.card).toMatchObject({
      header: {
        title: {
          content: "定时任务已完成",
        },
        template: "green",
      },
      config: {
        summary: {
          content: "定时任务已完成",
        },
      },
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "markdown",
            content: expect.stringContaining("任务已完成"),
          }),
        ]),
      },
    });
  });

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

  test("streams reasoning into the shared top reasoning area before assistant text completes", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_reason_stream_start",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_stream_1",
      }),
    );

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_reasoning_delta",
        eventId: "evt_reason_stream_delta_1",
        createdAt: "2026-03-28T00:00:00.200Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_stream_1",
        delta: "Let me think",
      }),
    );

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_reasoning_delta",
        eventId: "evt_reason_stream_delta_2",
        createdAt: "2026-03-28T00:00:00.400Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_stream_1",
        delta: "...",
      }),
    );

    expect(state.reasoning).toMatchObject({
      content: "Let me think...",
      active: true,
      expanded: true,
    });

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "assistant_message_delta",
        eventId: "evt_reason_stream_text",
        createdAt: "2026-03-28T00:00:00.600Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_stream_1",
        delta: "hello",
        accumulatedText: "hello",
      }),
    );

    expect(state.reasoning).toMatchObject({
      content: "Let me think...",
      active: false,
      expanded: false,
    });
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

  test("marks the prior run card as waiting approval and hides stop button", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_approval_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_approval_1",
      }),
    );
    state = markLarkRunAwaitingApproval(state);

    const cardText = JSON.stringify(renderLarkRunCard(state));
    expect(cardText).toContain("等待授权");
    expect(cardText).toContain("当前执行已暂停");
    expect(cardText).not.toContain("⏹ 停止");
  });

  test("marks the prior run card as continued or denied after approval resolution", () => {
    const base = markLarkRunAwaitingApproval(
      reduceLarkRunState(
        null,
        makeEnvelope({
          type: "assistant_message_started",
          eventId: "evt_approval_2",
          createdAt: "2026-03-28T00:00:00.000Z",
          sessionId: "sess_1",
          conversationId: "conv_1",
          branchId: "branch_1",
          runId: "run_1",
          turn: 1,
          messageId: "msg_approval_2",
        }),
      ),
    );

    const approvedText = JSON.stringify(
      renderLarkRunCard(markLarkRunApprovalResolved(base, "approve")),
    );
    expect(approvedText).toContain("已获授权");
    expect(approvedText).toContain("新的卡片");
    expect(approvedText).not.toContain("⏹ 停止");

    const deniedText = JSON.stringify(renderLarkRunCard(markLarkRunApprovalResolved(base, "deny")));
    expect(deniedText).toContain("已拒绝");
    expect(deniedText).toContain("本次执行已停止");
    expect(deniedText).not.toContain("⏹ 停止");
  });

  test("renders request_permissions inside the run transcript while awaiting approval", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_perm_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_perm_1",
        toolName: "request_permissions",
        args: { reason: "need access" },
      }),
    );
    state = markLarkRunAwaitingApproval(state);

    const cardText = JSON.stringify(renderLarkRunCard(state));
    expect(cardText).toContain("request_permissions");
    expect(cardText).toContain("等待你的授权");
    expect(cardText).toContain("等待授权");
  });

  test("renders schedule_task header with concise list summary", () => {
    const state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_sched_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_sched_1",
        toolName: "schedule_task",
        args: {
          action: "list",
          includeDisabled: true,
        },
      }),
    );

    const header = findFirstToolHeaderContent(renderLarkRunCard(state));
    expect(header).toBe("⏳ **schedule_task** — 任务列表");
    expect(header).not.toContain("includeDisabled");
    expect(header).not.toContain("{");
  });

  test("renders concise headers for read/find tools without repeated verbs", () => {
    const readState = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_read_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_read_1",
        toolName: "read",
        args: {
          path: "/tmp/report.txt",
        },
      }),
    );
    const readHeader = findFirstToolHeaderContent(renderLarkRunCard(readState));
    expect(readHeader).toBe("⏳ **read** — /tmp/report.txt");
    expect(readHeader).not.toContain("读取");

    const findState = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_find_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_find_1",
        toolName: "find",
        args: {
          pattern: "TODO",
          path: "/workspace/src",
        },
      }),
    );
    const findHeader = findFirstToolHeaderContent(renderLarkRunCard(findState));
    expect(findHeader).toBe("⏳ **find** — TODO · /workspace/src");
    expect(findHeader).not.toContain("查找");
  });

  test("renders review_permission_request header when approvalId is a string", () => {
    const state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "tool_call_started",
        eventId: "evt_perm_review_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        toolCallId: "tool_perm_review_1",
        toolName: "review_permission_request",
        args: {
          decision: "approve",
          approvalId: "42",
          reason: "ok",
        },
      }),
    );

    const header = findFirstToolHeaderContent(renderLarkRunCard(state));
    expect(header).toBe("⏳ **review_permission_request** — 已批准 · #42");
  });

  test("renders standalone approval cards with rich header styling and actions", () => {
    const approvalState = createLarkApprovalStateFromRequest({
      event: {
        type: "approval_requested",
        eventId: "evt_approval_card_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        approvalTarget: "user",
        title: "需要授权",
        reasonText: "当前操作需要你的授权才能继续。",
        expiresAt: null,
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });

    const cardText = JSON.stringify(buildLarkRenderedApprovalCard(approvalState).card);
    expect(cardText).toContain('"template":"blue"');
    expect(cardText).toContain("lock_chat_filled");
    expect(cardText).toContain("### 需要你的授权");
    expect(cardText).toContain("**操作**");
    expect(cardText).toContain("**原因**");
    expect(cardText).toContain("允许 1天");
    expect(cardText).toContain("允许 永久");
    expect(cardText).toContain("拒绝");
  });

  test("formats single-path approval titles with bold access and code-wrapped path", () => {
    const approvalState = createLarkApprovalStateFromRequest({
      event: {
        type: "approval_requested",
        eventId: "evt_approval_card_fmt_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_fmt_1",
        approvalTarget: "user",
        title: "Approval required: Write /Users/daniel/Desktop/test-new-2.js",
        reasonText: "当前操作需要你的授权才能继续。",
        expiresAt: null,
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });

    const cardText = JSON.stringify(buildLarkRenderedApprovalCard(approvalState).card);
    expect(cardText).toContain(
      "Approval required: **Write** `/Users/daniel/Desktop/test-new-2.js`",
    );
  });

  test("does not repeat resolved approval state text inside the card body", () => {
    const approvalState = createLarkApprovalStateFromRequest({
      event: {
        type: "approval_requested",
        eventId: "evt_approval_card_fmt_2",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_fmt_2",
        approvalTarget: "user",
        title: "Approval required: Write /Users/daniel/Desktop/test-new-2.js",
        reasonText: "当前操作需要你的授权才能继续。",
        expiresAt: null,
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });

    const resolved = {
      ...approvalState,
      resolved: true as const,
      decision: "approve" as const,
      actor: "user:test",
    };

    const cardText = JSON.stringify(buildLarkRenderedApprovalCard(resolved).card);
    expect(cardText).not.toContain("### 已授权");
    expect(cardText).toContain("授权请求 — 授权成功");
    expect(cardText).toContain("**结果**：agent 将继续执行。");
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

  test("renders terminal failure details even when no transcript blocks exist", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_fail_1",
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
        type: "run_failed",
        eventId: "evt_fail_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        errorKind: "upstream",
        errorMessage: "403 Key limit exceeded (daily limit).",
        retryable: false,
      }),
    );

    const rendered = buildLarkRenderedRunCard(state);
    const cardText = JSON.stringify(rendered.card);
    expect(cardText).toContain("执行失败");
    expect(cardText).toContain("403 Key limit exceeded (daily limit).");
    expect(rendered.card.config).toMatchObject({
      summary: { content: "已失败" },
    });
  });

  test("renders terminal failure summary even when transcript blocks already exist", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_fail_summary_1",
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
        eventId: "evt_fail_summary_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        turn: 1,
        messageId: "msg_1",
        text: "Trying the requested operation now.",
        reasoningText: null,
        toolCalls: [],
        usage: null,
      }),
    );

    state = reduceLarkRunState(
      state,
      makeEnvelope({
        type: "run_failed",
        eventId: "evt_fail_summary_3",
        createdAt: "2026-03-28T00:00:02.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        errorKind: "internal_error",
        errorMessage: "Tool execution failed due to an internal runtime error.",
        retryable: false,
      }),
    );

    const rendered = buildLarkRenderedRunCard(state);
    const cardText = JSON.stringify(rendered.card);
    expect(cardText).toContain("Trying the requested operation now.");
    expect(cardText).toContain("执行失败");
    expect(cardText).toContain("Tool execution failed due to an internal runtime error.");
    expect(rendered.card.config).toMatchObject({
      summary: { content: "已失败" },
    });
  });

  test("renders terminal cancellation details even when no transcript blocks exist", () => {
    let state = reduceLarkRunState(
      null,
      makeEnvelope({
        type: "assistant_message_started",
        eventId: "evt_cancel_1",
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
        type: "run_cancelled",
        eventId: "evt_cancel_2",
        createdAt: "2026-03-28T00:00:01.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        scenario: "chat",
        modelId: "model_1",
        reason: "stop requested from lark card action",
      }),
    );

    const rendered = buildLarkRenderedRunCard(state);
    const cardText = JSON.stringify(rendered.card);
    expect(cardText).toContain("已停止");
    expect(cardText).toContain("stop requested from lark card action");
    expect(rendered.card.config).toMatchObject({
      summary: { content: "已停止" },
    });
  });
});
