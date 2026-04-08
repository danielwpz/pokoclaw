import { describe, expect, test } from "vitest";

import {
  buildMeditationBucketSystemPrompt,
  buildMeditationBucketUserPrompt,
  buildMeditationConsolidationSystemPrompt,
  buildMeditationConsolidationUserPrompt,
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
    expect(systemPrompt).toContain('"memory_candidates": ["string"]');
    expect(userPrompt).toContain("<subagent_profile>");
    expect(userPrompt).toContain("Atlas Frontend");
    expect(userPrompt).toContain("Recent atlas summary");
    expect(userPrompt).toContain("stop:1");
    expect(userPrompt).toContain("## Current Run");
  });

  test("builds consolidation system and user prompts with conservative rewrite guidance", () => {
    const systemPrompt = buildMeditationConsolidationSystemPrompt();
    const userPrompt = buildMeditationConsolidationUserPrompt({
      currentDate: "2026-04-08",
      timezone: "Asia/Shanghai",
      sharedMemoryCurrent: "# Shared Memory\n- Ask for narrow permissions first.\n",
      agentContexts: [
        {
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recent atlas summary",
          privateMemoryCurrent: "# Private Memory\n- Check design tokens first.\n",
          bucketNote: "This bucket kept showing avoidable permission friction.",
          memoryCandidates: [
            "When read or grep repeatedly hits protected paths, request the needed permission early.",
          ],
        },
        {
          agentId: "agent_main_1",
          agentKind: "main",
          displayName: "Pokeclaw Main Agent",
          description: "Owns the main user conversation.",
          workdir: "/repo/pokeclaw",
          compactSummary: null,
          privateMemoryCurrent: null,
          bucketNote: "The main agent also saw repeated permission friction.",
          memoryCandidates: ["Lead with diagnosis before long explanation."],
        },
      ],
      recentMeditationExcerpts: [
        {
          date: "2026-04-07",
          text: "Another bucket saw the same permission escalation issue.",
        },
      ],
    });

    expect(systemPrompt).toContain("- delete the substance of existing memory");
    expect(systemPrompt).toContain(
      "Promotion is optional. If no durable memory change is clearly justified, it is correct to keep shared_memory_rewrite as null and private_memory_rewrites as [].",
    );
    expect(systemPrompt).toContain("When in doubt, preserve the specific constant.");
    expect(systemPrompt).toContain('"shared_memory_rewrite": "string | null"');
    expect(userPrompt).toContain("<shared_memory_current>");
    expect(userPrompt).toContain("Ask for narrow permissions first.");
    expect(userPrompt).toContain('<subagent_context agent_id="agent_sub_1">');
    expect(userPrompt).toContain("- Agent kind: sub");
    expect(userPrompt).toContain("- Agent kind: main");
    expect(userPrompt).toContain("- This is the main agent. It has no private memory target.");
    expect(userPrompt).toContain("This bucket kept showing avoidable permission friction.");
    expect(userPrompt).toContain("Another bucket saw the same permission escalation issue.");
  });
});
