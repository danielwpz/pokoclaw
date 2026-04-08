import { describe, expect, test } from "vitest";

import {
  buildFailureSignature,
  buildMeditationBuckets,
  SHARED_BUCKET_ID,
} from "@/src/meditation/clustering.js";

describe("meditation clustering", () => {
  test("merges nearby stop facts from the same session into one cluster", () => {
    const buckets = buildMeditationBuckets({
      stops: [
        {
          runId: "run_1",
          sessionId: "sess_1",
          agentId: "agent_1",
          taskRunId: null,
          conversationId: "conv_1",
          branchId: "branch_1",
          createdAt: "2026-04-08T00:00:00.000Z",
          sourceKind: "button",
          requestScope: "run",
        },
        {
          runId: "run_2",
          sessionId: "sess_1",
          agentId: "agent_1",
          taskRunId: null,
          conversationId: "conv_1",
          branchId: "branch_1",
          createdAt: "2026-04-08T00:10:00.000Z",
          sourceKind: "button",
          requestScope: "run",
        },
      ],
      taskFailures: [],
      failedToolResults: [],
    });

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      bucketId: "agent_1",
      score: 50,
      preferredSessionIds: ["sess_1"],
      clusters: [
        {
          kind: "stop",
          stopCount: 2,
          sessionIds: ["sess_1"],
        },
      ],
    });
  });

  test("builds tool burst and tool repeat clusters inside the same agent bucket", () => {
    const failedToolResults = [
      {
        id: "m1",
        sessionId: "sess_1",
        ownerAgentId: "agent_1",
        seq: 10,
        createdAt: "2026-04-08T00:00:10.000Z",
        toolName: "bash",
        detailsCode: "permission_denied",
        requestScopeKind: "bash.full_access",
        requestPrefix0: "lark-cli",
        contentText: "Permission request denied.",
      },
      {
        id: "m2",
        sessionId: "sess_1",
        ownerAgentId: "agent_1",
        seq: 11,
        createdAt: "2026-04-08T00:00:11.000Z",
        toolName: "bash",
        detailsCode: "permission_denied",
        requestScopeKind: "bash.full_access",
        requestPrefix0: "lark-cli",
        contentText: "Permission request denied.",
      },
      {
        id: "m3",
        sessionId: "sess_2",
        ownerAgentId: "agent_1",
        seq: 20,
        createdAt: "2026-04-08T00:05:00.000Z",
        toolName: "bash",
        detailsCode: "permission_denied",
        requestScopeKind: "bash.full_access",
        requestPrefix0: "lark-cli",
        contentText: "Permission request denied.",
      },
    ];

    const buckets = buildMeditationBuckets({
      stops: [],
      taskFailures: [],
      failedToolResults,
    });

    const firstFailedToolResult = failedToolResults[0];
    if (firstFailedToolResult == null) {
      throw new Error("expected first failed tool result");
    }

    expect(buildFailureSignature(firstFailedToolResult)).toBe(
      "bash|permission_denied|bash.full_access|lark-cli|permission request denied.",
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.score).toBe(35);
    expect(buckets[0]?.clusters).toMatchObject([
      {
        kind: "tool_burst",
        count: 2,
        sessionId: "sess_1",
      },
      {
        kind: "tool_repeat",
        count: 3,
      },
    ]);
  });

  test("falls back to the shared bucket when no owner agent exists", () => {
    const buckets = buildMeditationBuckets({
      stops: [],
      taskFailures: [],
      failedToolResults: [
        {
          id: "m1",
          sessionId: "sess_shared",
          ownerAgentId: null,
          seq: 1,
          createdAt: "2026-04-08T00:00:00.000Z",
          toolName: "web_fetch",
          detailsCode: "web_fetch_failed",
          requestScopeKind: null,
          requestPrefix0: null,
          contentText: "fetch failed",
        },
        {
          id: "m2",
          sessionId: "sess_shared",
          ownerAgentId: null,
          seq: 2,
          createdAt: "2026-04-08T00:00:01.000Z",
          toolName: "web_fetch",
          detailsCode: "web_fetch_failed",
          requestScopeKind: null,
          requestPrefix0: null,
          contentText: "fetch failed",
        },
      ],
    });

    expect(buckets).toMatchObject([
      {
        bucketId: SHARED_BUCKET_ID,
        agentId: null,
        score: 35,
      },
    ]);
  });
});
