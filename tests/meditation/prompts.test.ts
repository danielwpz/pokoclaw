import { describe, expect, test } from "vitest";

import {
  buildMeditationBucketSystemPrompt,
  buildMeditationBucketUserPrompt,
  buildMeditationConsolidationEvaluationSystemPrompt,
  buildMeditationConsolidationEvaluationUserPrompt,
  buildMeditationConsolidationRewriteSystemPrompt,
  buildMeditationConsolidationRewriteUserPrompt,
  buildMeditationFindingId,
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
          {
            id: "tool_burst:1",
            kind: "tool_burst",
            startedAt: "2026-04-07T12:21:00.000Z",
            endedAt: "2026-04-07T12:22:00.000Z",
            count: 2,
            signatures: ["bash:permission_denied"],
            episodeTimeline: {
              id: "sess_1-ep1",
              sessionId: "sess_1",
              startSeq: 9,
              endSeq: 12,
              triggerStartSeq: 10,
              triggerEndSeq: 11,
              triggerKinds: ["consecutive_failures"],
              totalToolResults: 2,
              failedToolResults: 2,
              events: [
                {
                  seq: 9,
                  createdAt: "2026-04-07T12:20:30.000Z",
                  role: "user",
                  messageType: "text",
                  summary: "please use the browser flow only",
                },
                {
                  seq: 10,
                  createdAt: "2026-04-07T12:21:00.000Z",
                  role: "tool",
                  messageType: "tool_result",
                  summary:
                    'tool=bash | status=error | code=permission_denied | request={"scopes":[{"kind":"bash.full_access"}],"prefix":["lark-cli"]} | output="Permission request denied."',
                },
              ],
            },
          },
        ],
      },
    });

    expect(systemPrompt).toContain("reduce future user friction");
    expect(systemPrompt).toContain("## Product Context");
    expect(systemPrompt).toContain("## Facts Vs Judgments");
    expect(systemPrompt).toContain(
      "A fact is something directly supported by the bucket evidence.",
    );
    expect(systemPrompt).toContain("A judgment is an opinion about importance");
    expect(systemPrompt).toContain("## How To Work");
    expect(systemPrompt).toContain("1. Read the bucket evidence");
    expect(systemPrompt).toContain("## Repeated Failure And Later Recovery");
    expect(systemPrompt).toContain(
      "repeated failed attempts -> user correction or agent method change -> later successful attempts.",
    );
    expect(systemPrompt).toContain("For each finding, include 1 to 3 short factual examples");
    expect(systemPrompt).toContain("## Issue Type Guide");
    expect(systemPrompt).toContain("user_preference_signal:");
    expect(systemPrompt).toContain("agent_workflow_issue:");
    expect(systemPrompt).toContain("tool_or_source_quirk:");
    expect(systemPrompt).toContain("## Scope Hint Guide");
    expect(systemPrompt).toContain("Do not turn the note into root-cause analysis");
    expect(systemPrompt).toContain("Do not prescribe fixes or say what should be changed");
    expect(systemPrompt).toContain("Prefer wording like 'X happened'");
    expect(systemPrompt).toContain(
      "avoid judgment-heavy verbs such as 'captures', 'shows', 'indicates'",
    );
    expect(systemPrompt).toContain("## Style Contract");
    expect(systemPrompt).toContain("factual incident digest, not an analysis report");
    expect(systemPrompt).toContain('"examples": ["string"]');
    expect(systemPrompt).toContain('"note": "string"');
    expect(systemPrompt).toContain('"findings": [');
    expect(userPrompt).toContain("<subagent_profile>");
    expect(userPrompt).toContain("Atlas Frontend");
    expect(userPrompt).toContain("Recent atlas summary");
    expect(userPrompt).toContain("stop:1");
    expect(userPrompt).toContain('kind="tool_burst" id="tool_burst:1"');
    expect(userPrompt).toContain("Trigger kinds: consecutive_failures");
    expect(userPrompt).toContain("please use the browser flow only");
    expect(userPrompt).toContain("tool=bash | status=error | code=permission_denied");
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
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
              summary: "Repeated protected-path reads suggest earlier narrow permission requests.",
              issueType: "tool_or_source_quirk",
              scopeHint: "subagent",
              clusterIds: ["tool_repeat:1"],
              evidenceSummary: "The same permission-denied pattern repeated in one session.",
              examples: [
                "user: please use narrower permissions first",
                "tool error: Permission request denied.",
              ],
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
              findingId: buildMeditationFindingId("bucket_main_1", 0),
              summary: "The user repeatedly wanted the likely diagnosis first.",
              issueType: "user_preference_signal",
              scopeHint: "shared",
              clusterIds: ["stop:1"],
              evidenceSummary: "The user stopped the run and redirected the response style.",
              examples: ["user quote: lead with the diagnosis first"],
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
      "Only treat a finding as promotion-worthy when the evidence is strong enough",
    );
    expect(systemPrompt).toContain("## What Good Durable Memory Looks Like");
    expect(systemPrompt).toContain("A good durable memory is a short future-facing rule.");
    expect(systemPrompt).toContain("Bad memory shape");
    expect(systemPrompt).toContain(
      "Copy each finding_id exactly as it appears in Current Findings.",
    );
    expect(systemPrompt).toContain(
      "Before submit, verify that every current finding_id appears exactly once",
    );
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
    expect(userPrompt).toContain("examples:");
    expect(userPrompt).toContain("tool error: Permission request denied.");
  });

  test("builds consolidation rewrite prompts with approved findings only", () => {
    const systemPrompt = buildMeditationConsolidationRewriteSystemPrompt();
    const userPrompt = buildMeditationConsolidationRewriteUserPrompt({
      currentDate: "2026-04-08",
      timezone: "Asia/Shanghai",
      sharedMemoryCurrent: "# Shared Memory\n- Ask for narrow permissions first.\n",
      approvedSharedFindings: [
        {
          findingId: buildMeditationFindingId("bucket_main_1", 0),
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
          examples: ["user quote: lead with the diagnosis first"],
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
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
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
              examples: ["tool error: Permission request denied."],
            },
          ],
        },
      ],
    });

    expect(systemPrompt).toContain("Do not reevaluate the world from scratch.");
    expect(systemPrompt).toContain("Write durable future-facing rules, not incident reports.");
    expect(systemPrompt).toContain("Avoid timestamps, session ids, occurrence counts");
    expect(systemPrompt).toContain("## Learn The Strategy, Not The Incident");
    expect(systemPrompt).toContain("Generalize one level above the incident:");
    expect(systemPrompt).toContain(
      "When shell-wide permissions are denied, switch earlier to narrower browser-specific or split-command execution.",
    );
    expect(systemPrompt).toContain("## Rewrite Style");
    expect(systemPrompt).toContain(
      "If an approved finding cannot be rewritten as a short future-facing rule, leave that target unchanged.",
    );
    expect(systemPrompt).toContain("## Good Rewrite Examples");
    expect(systemPrompt).toContain("## Bad Rewrite Examples");
    expect(systemPrompt).toContain('"shared_memory_rewrite": "string | null"');
    expect(userPrompt).toContain("Approved Shared Findings");
    expect(userPrompt).toContain("Approved Private Findings By Bucket");
    expect(userPrompt).toContain("shared_memory");
    expect(userPrompt).toContain("private_memory");
    expect(userPrompt).toContain("This keeps repeating in atlas-web work.");
    expect(userPrompt).toContain("tool error: Permission request denied.");
  });
});
