import { describe, expect, test } from "vitest";

import {
  buildApprovedToolExecutionState,
  buildRuntimeModeToolExecutionState,
} from "@/src/agent/tool-approval-state.js";

describe("tool approval state", () => {
  test("builds runtime-mode auto approval state only for non-normal skip-human modes", () => {
    expect(buildRuntimeModeToolExecutionState(undefined)).toBeUndefined();
    expect(
      buildRuntimeModeToolExecutionState({
        autopilotEnabled: false,
        yoloEnabled: false,
        source: "normal",
        skipHumanApproval: false,
      }),
    ).toBeUndefined();
    expect(
      buildRuntimeModeToolExecutionState({
        autopilotEnabled: true,
        yoloEnabled: false,
        source: "autopilot",
        skipHumanApproval: true,
      }),
    ).toEqual({
      runtimeModeAutoApproval: {
        source: "autopilot",
      },
    });
  });

  test("returns the base approval state unchanged for explicit human approvals", () => {
    const baseState = {
      bashFullAccess: {
        approved: true as const,
        mode: "one_shot" as const,
        approvalId: 0,
        toolCallId: "tool_1",
      },
    };

    expect(
      buildApprovedToolExecutionState({
        baseState,
        request: {
          scopes: [{ kind: "bash.full_access", prefix: ["agent-browser", "open"] }],
        },
        approvalId: 43,
        skippedHumanApproval: false,
      }),
    ).toBe(baseState);
  });

  test("preserves bash one-shot toolCallId when rebuilding skipped-human approval state", () => {
    const state = buildApprovedToolExecutionState({
      baseState: {
        bashFullAccess: {
          approved: true,
          mode: "one_shot",
          approvalId: 0,
          toolCallId: "tool_1",
        },
      },
      request: {
        scopes: [{ kind: "bash.full_access", prefix: ["agent-browser", "wait"] }],
      },
      approvalId: 43,
      skippedHumanApproval: true,
    });

    expect(state?.bashFullAccess).toEqual({
      approved: true,
      mode: "one_shot",
      approvalId: 43,
      toolCallId: "tool_1",
    });
  });

  test("deduplicates ephemeral scopes when rebuilding skipped-human approval state", () => {
    const state = buildApprovedToolExecutionState({
      baseState: {
        ephemeralPermissionScopes: [{ kind: "fs.write", path: "/tmp/report.md" }],
      },
      request: {
        scopes: [
          { kind: "fs.write", path: "/tmp/report.md" },
          { kind: "fs.read", path: "/tmp/report.md" },
        ],
      },
      approvalId: 44,
      skippedHumanApproval: true,
    });

    expect(state?.ephemeralPermissionScopes).toEqual([
      { kind: "fs.write", path: "/tmp/report.md" },
      { kind: "fs.read", path: "/tmp/report.md" },
    ]);
  });
});
