import { describe, expect, test } from "vitest";

import type { RuntimeNudgeEvent } from "@/src/agent/events.js";
import {
  addLarkApprovalRuntimeNudge,
  createLarkApprovalStateFromRequest,
} from "@/src/channels/lark/approval-state.js";
import { buildLarkRenderedApprovalCard } from "@/src/channels/lark/render.js";

function makeYoloSuggestionEvent(flowId: string): RuntimeNudgeEvent {
  return {
    type: "runtime_nudge",
    eventId: "evt_nudge_1",
    createdAt: "2026-03-28T00:00:01.000Z",
    sessionId: "sess_1",
    conversationId: "conv_1",
    branchId: "branch_1",
    runId: "run_1",
    ownerAgentId: "agent_1",
    anchor: {
      type: "approval_flow",
      id: flowId,
    },
    nudge: {
      kind: "yolo_suggestion",
      message:
        "💡 Too many approval stops? Send `/yolo` if you want this agent to keep going without asking each time.",
    },
  };
}

describe("lark approval runtime nudges", () => {
  test("renders anchored yolo suggestions inside the live approval card", () => {
    const approvalState = createLarkApprovalStateFromRequest({
      event: {
        type: "approval_requested",
        eventId: "evt_approval_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        approvalFlowId: "flow_1",
        approvalAttemptIndex: 1,
        approvalTarget: "user",
        title: "Approval required",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/output.txt" }],
        },
        reasonText: "需要写入输出文件。",
        expiresAt: "2026-03-28T00:05:00.000Z",
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });

    const withNudge = addLarkApprovalRuntimeNudge(approvalState, makeYoloSuggestionEvent("flow_1"));
    const card = buildLarkRenderedApprovalCard(withNudge).card as {
      body?: { elements?: Array<Record<string, unknown>> };
    };
    const elements = card.body?.elements ?? [];
    const bodyMarkdown = elements[0]?.content;
    const nudgeMarkdown = elements[1]?.content;
    const cardText = JSON.stringify(card);

    expect(cardText).toContain(
      "> 💡 Too many approval stops? Send `/yolo` if you want this agent to keep going without asking each time.",
    );
    expect(bodyMarkdown).toEqual(expect.stringContaining("**有效期至**"));
    expect(bodyMarkdown).not.toEqual(expect.stringContaining("Too many approval stops?"));
    expect(nudgeMarkdown).toBe(
      "> 💡 Too many approval stops? Send `/yolo` if you want this agent to keep going without asking each time.",
    );
    expect(cardText).not.toContain("你处理后，agent 才会继续执行");
  });

  test("drops anchored nudges once the approval card is no longer live", () => {
    const approvalState = createLarkApprovalStateFromRequest({
      event: {
        type: "approval_requested",
        eventId: "evt_approval_2",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_2",
        approvalFlowId: "flow_2",
        approvalAttemptIndex: 1,
        approvalTarget: "user",
        title: "Approval required",
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/output.txt" }],
        },
        reasonText: "需要写入输出文件。",
        expiresAt: null,
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });
    const resolved = {
      ...approvalState,
      currentApprovalId: null,
      phase: "approved" as const,
      resolved: true,
      decision: "approve" as const,
      actor: "user",
    };

    expect(addLarkApprovalRuntimeNudge(resolved, makeYoloSuggestionEvent("flow_2"))).toBe(resolved);
  });
});
