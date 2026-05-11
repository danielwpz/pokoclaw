import { describe, expect, test } from "vitest";
import { createLarkApprovalStateFromRequest } from "@/src/channels/lark/approval-state.js";
import { buildLarkRenderedApprovalCard } from "@/src/channels/lark/render.js";

describe("lark approval cards", () => {
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
        approvalFlowId: "approval_1",
        approvalAttemptIndex: 1,
        approvalTarget: "user",
        title: "需要授权",
        request: {
          scopes: [
            { kind: "fs.read", path: "/Users/example/project/README.md" },
            { kind: "fs.write", path: "/Users/example/project/output.txt" },
          ],
        },
        reasonText: "当前操作需要你的授权才能继续。",
        expiresAt: null,
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });

    const cardText = JSON.stringify(buildLarkRenderedApprovalCard(approvalState).card);
    expect(cardText).toContain('"template":"blue"');
    expect(cardText).toContain("lock_chat_filled");
    expect(cardText).not.toContain('"subtitle"');
    expect(cardText).toContain("### 授权运行命令");
    expect(cardText).not.toContain("**操作**");
    expect(cardText).toContain("**权限**");
    expect(cardText).toContain("**Read** `/Users/example/project/README.md`");
    expect(cardText).toContain("**Write** `/Users/example/project/output.txt`");
    expect(cardText).toContain("**原因**");
    expect(cardText).toContain("允许 1天");
    expect(cardText).toContain("允许 永久");
    expect(cardText).toContain("拒绝");
  });

  test("renders MCP approval cards without internal command metadata", () => {
    const approvalState = createLarkApprovalStateFromRequest({
      event: {
        type: "approval_requested",
        eventId: "evt_mcp_approval_card_1",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "sess_1",
        conversationId: "conv_1",
        branchId: "branch_1",
        runId: "run_1",
        approvalId: "approval_1",
        approvalFlowId: "approval_1",
        approvalAttemptIndex: 1,
        approvalTarget: "user",
        title: "Approval required: MCP · Linear · Save issue",
        request: {
          scopes: [
            {
              kind: "mcp.tool",
              server: "linear",
              tool: "save_issue",
              serverFingerprint: "server-fingerprint",
              catalogVersion: "0651af2c20aaf14f6be8f5d1588e98c53930c2fded8b65e0dbe51a8e28d7d8a4",
            },
          ],
        },
        reasonText: "需要授权 MCP 工具 MCP · Linear · Save issue。",
        expiresAt: null,
      },
      sourceRunCardObjectId: "run_1:seg:1",
    });

    const cardText = JSON.stringify(buildLarkRenderedApprovalCard(approvalState).card);
    expect(cardText).toContain("### 授权调用 MCP 工具");
    expect(cardText).toContain("MCP · Linear · Save issue");
    expect(cardText).toContain("**权限**");
    expect(cardText).not.toContain("**命令**");
    expect(cardText).not.toContain("mcp__linear__save_issue");
    expect(cardText).not.toContain(
      "0651af2c20aaf14f6be8f5d1588e98c53930c2fded8b65e0dbe51a8e28d7d8a4",
    );
  });
});
