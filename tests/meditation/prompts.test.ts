import { describe, expect, test } from "vitest";

import {
  buildMeditationBucketSystemPrompt,
  buildMeditationBucketUserPrompt,
  buildMeditationConsolidationEvaluationSystemPrompt,
  buildMeditationConsolidationEvaluationUserPrompt,
  buildMeditationConsolidationRewriteSystemPrompt,
  buildMeditationConsolidationRewriteUserPrompt,
} from "@/src/meditation/prompts.js";

describe("meditation prompts", () => {
  test("builds bucket system and user prompts with stable guidance and dynamic evidence", () => {
    const systemPrompt = buildMeditationBucketSystemPrompt();
    const userPrompt = buildMeditationBucketUserPrompt({
      currentDate: "2026-04-08",
      timezone: "Asia/Shanghai",
      meditationWindow: {
        startAt: "2026-04-07T00:00:00.000Z",
        endAt: "2026-04-08T00:00:00.000Z",
        clippedByLookback: false,
      },
      bucket: {
        bucketId: "agent_sub_1",
        agentId: "agent_sub_1",
        score: 85,
        preferredSessionIds: ["sess_1"],
        profile: {
          agentId: "agent_sub_1",
          kind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recent atlas summary",
        },
        clusters: [
          {
            id: "stop:1",
            kind: "stop",
            startedAt: "2026-04-07T12:00:00.000Z",
            endedAt: "2026-04-07T12:00:00.000Z",
            stopCount: 1,
            contextMessages: [
              {
                id: "m1",
                sessionId: "sess_1",
                seq: 1,
                role: "user",
                messageType: "text",
                visibility: "user_visible",
                stopReason: null,
                errorMessage: null,
                createdAt: "2026-04-07T11:59:00.000Z",
                payloadJson: '{"content":[{"type":"text","text":"stop that"}]}',
              },
            ],
          },
        ],
      },
    });

    expect(systemPrompt).toContain("reduce future user friction");
    expect(systemPrompt).toContain("## Product Context");
    expect(systemPrompt).toContain('"note": "string"');
    expect(systemPrompt).toContain('"findings": [');
    expect(userPrompt).toContain("<subagent_profile>");
    expect(userPrompt).toContain("Atlas Frontend");
    expect(userPrompt).toContain("Recent atlas summary");
    expect(userPrompt).toContain("stop:1");
    expect(userPrompt).toContain("## Current Run");
  });

  test("builds consolidation evaluation prompts with explicit judgment fields", () => {
    const systemPrompt = buildMeditationConsolidationEvaluationSystemPrompt();
    const userPrompt = buildMeditationConsolidationEvaluationUserPrompt({
      currentDate: "2026-04-08",
      timezone: "Asia/Shanghai",
      sharedMemoryCurrent: "# Shared Memory\n- Ask for narrow permissions first.\n",
      bucketPackets: [
        {
          bucketId: "bucket_sub_1",
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recent atlas summary",
          privateMemoryCurrent: "# Private Memory\n- Check design tokens first.\n",
          bucketNote: "This bucket kept showing avoidable permission friction.",
          currentFindings: [
            {
              findingId: "bucket_sub_1/finding-1",
              summary: "Repeated protected-path reads suggest earlier narrow permission requests.",
              issueType: "tool_or_source_quirk",
              scopeHint: "subagent",
              clusterIds: ["tool_repeat:1"],
              evidenceSummary: "The same permission-denied pattern repeated in one session.",
            },
          ],
          recentHistory: [
            {
              date: "2026-04-07",
              runId: "run_prev",
              summary: "The same permission escalation issue happened yesterday.",
              issueType: "tool_or_source_quirk",
              scopeHint: "subagent",
              evidenceSummary: "Yesterday's run showed the same signature.",
            },
          ],
          recentHistoryStats: {
            daysWithFindings: 1,
            totalFindings: 1,
            countsByIssueType: {
              tool_or_source_quirk: 1,
            },
          },
        },
        {
          bucketId: "bucket_main_1",
          agentId: "agent_main_1",
          agentKind: "main",
          displayName: "Pokoclaw Main Agent",
          description: "Owns the main user conversation.",
          workdir: "/repo/pokoclaw",
          compactSummary: null,
          privateMemoryCurrent: null,
          bucketNote: "The main agent also saw repeated permission friction.",
          currentFindings: [
            {
              findingId: "bucket_main_1/finding-1",
              summary: "The user repeatedly wanted the likely diagnosis first.",
              issueType: "user_preference_signal",
              scopeHint: "shared",
              clusterIds: ["stop:1"],
              evidenceSummary: "The user stopped the run and redirected the response style.",
            },
          ],
          recentHistory: [],
          recentHistoryStats: {
            daysWithFindings: 0,
            totalFindings: 0,
            countsByIssueType: {},
          },
        },
      ],
    });

    expect(systemPrompt).toContain("This evaluation step is the judgment layer.");
    expect(systemPrompt).toContain(
      '"promotion_decision": "shared_memory | private_memory | keep_in_meditation"',
    );
    expect(userPrompt).toContain("<shared_memory_current>");
    expect(userPrompt).toContain("Ask for narrow permissions first.");
    expect(userPrompt).toContain('<bucket_packet bucket_id="bucket_sub_1" agent_id="agent_sub_1">');
    expect(userPrompt).toContain("- Agent kind: sub");
    expect(userPrompt).toContain("- Agent kind: main");
    expect(userPrompt).toContain("- This agent has no private memory target in this step.");
    expect(userPrompt).toContain("This bucket kept showing avoidable permission friction.");
    expect(userPrompt).toContain("run_prev");
  });

  test("builds consolidation rewrite prompts with approved findings only", () => {
    const systemPrompt = buildMeditationConsolidationRewriteSystemPrompt();
    const userPrompt = buildMeditationConsolidationRewriteUserPrompt({
      currentDate: "2026-04-08",
      timezone: "Asia/Shanghai",
      sharedMemoryCurrent: "# Shared Memory\n- Ask for narrow permissions first.\n",
      approvedSharedFindings: [
        {
          findingId: "bucket_main_1/finding-1",
          agentId: "agent_main_1",
          agentKind: "main",
          priority: "high",
          durability: "durable",
          promotionDecision: "shared_memory",
          reason: "This should affect shared coordination behavior.",
          summary: "Lead with the likely diagnosis before a long explanation.",
          issueType: "user_preference_signal",
          scopeHint: "shared",
          evidenceSummary: "The user repeatedly redirected the response style.",
        },
      ],
      bucketPackets: [
        {
          bucketId: "bucket_sub_1",
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recent atlas summary",
          privateMemoryCurrent: "# Private Memory\n- Check design tokens first.\n",
          approvedPrivateFindings: [
            {
              findingId: "bucket_sub_1/finding-1",
              agentId: "agent_sub_1",
              agentKind: "sub",
              priority: "high",
              durability: "durable",
              promotionDecision: "private_memory",
              reason: "This keeps repeating in atlas-web work.",
              summary: "Repeated protected-path reads suggest earlier narrow permission requests.",
              issueType: "tool_or_source_quirk",
              scopeHint: "subagent",
              evidenceSummary: "The same permission-denied pattern repeated in one session.",
            },
          ],
        },
      ],
    });

    expect(systemPrompt).toContain("Do not reevaluate the world from scratch.");
    expect(systemPrompt).toContain('"shared_memory_rewrite": "string | null"');
    expect(userPrompt).toContain("Approved Shared Findings");
    expect(userPrompt).toContain("Approved Private Findings By Bucket");
    expect(userPrompt).toContain("shared_memory");
    expect(userPrompt).toContain("private_memory");
    expect(userPrompt).toContain("This keeps repeating in atlas-web work.");
  });
});
