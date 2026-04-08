import { afterEach, describe, expect, test } from "vitest";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { PiBridgeRunTurnResult } from "@/src/agent/llm/pi-bridge.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import {
  runMeditationBucketAgent,
  runMeditationConsolidationAgent,
} from "@/src/meditation/agent-runner.js";
import type { PreparedMeditationBucket } from "@/src/meditation/bucket-prep.js";
import type { MeditationConsolidationPromptInput } from "@/src/meditation/prompts.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function createModel(): ResolvedModel {
  return {
    id: "openai_main/gpt-5-mini",
    providerId: "openai_main",
    upstreamId: "gpt-5-mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: false,
    reasoning: { enabled: true },
    provider: {
      id: "openai_main",
      api: "openai-responses",
      apiKey: "test-key",
    },
  };
}

function createTurnResult(args: Record<string, unknown>): PiBridgeRunTurnResult {
  return {
    provider: "openai_main",
    model: "gpt-5-mini",
    modelApi: "openai-responses",
    stopReason: "toolUse",
    content: [
      {
        type: "thinking",
        thinking:
          "I should preserve the main friction signal but keep reasoning out of the final submit payload.",
      },
      {
        type: "toolCall",
        id: "tool_1",
        name: "submit",
        arguments: args,
      },
    ],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}

function createPreparedBucket(): PreparedMeditationBucket {
  return {
    bucketId: "agent_sub_1",
    agentId: "agent_sub_1",
    score: 80,
    preferredSessionIds: ["sess_sub_1"],
    profile: {
      agentId: "agent_sub_1",
      kind: "sub",
      displayName: "Atlas Frontend",
      description: "Handles atlas-web frontend tasks.",
      workdir: "/repo/atlas-web",
      compactSummary: "Recently fixing frontend regressions.",
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
            id: "msg_1",
            sessionId: "sess_sub_1",
            seq: 10,
            role: "user",
            messageType: "text",
            visibility: "user_visible",
            stopReason: null,
            errorMessage: null,
            createdAt: "2026-04-07T12:00:00.000Z",
            payloadJson: JSON.stringify({ content: "先别解释，先定位问题。" }),
          },
        ],
      },
    ],
  };
}

describe("meditation agent runner", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("runs bucket meditation with a submit-only tool contract", async () => {
    handle = await createTestDatabase(import.meta.url);

    const result = await runMeditationBucketAgent({
      bridge: {
        async completeTurn(input) {
          expect(input.systemPrompt).toContain("reduce future user friction");
          expect(input.messages).toHaveLength(1);
          expect(input.messages[0]?.payloadJson).toContain("Atlas Frontend");
          return createTurnResult({
            note: "The user clearly wanted this SubAgent to lead with diagnosis before explanation.",
            memory_candidates: [
              "For atlas-web frontend debugging, lead with the likely diagnosis before a long explanation.",
            ],
          });
        },
      },
      model: createModel(),
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      currentDate: "2026-04-08",
      timezone: "UTC",
      meditationWindow: {
        startAt: "2026-04-01T00:00:00.000Z",
        endAt: "2026-04-08T00:00:00.000Z",
        clippedByLookback: true,
      },
      bucket: createPreparedBucket(),
    });

    expect(result.systemPrompt).toContain("reduce future user friction");
    expect(result.prompt).toContain("Atlas Frontend");
    expect(result.submission).toEqual({
      note: "The user clearly wanted this SubAgent to lead with diagnosis before explanation.",
      memory_candidates: [
        "For atlas-web frontend debugging, lead with the likely diagnosis before a long explanation.",
      ],
    });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.content[0]).toMatchObject({
      type: "thinking",
    });
  });

  test("runs consolidation with shared and private rewrite output", async () => {
    handle = await createTestDatabase(import.meta.url);

    const promptInput: MeditationConsolidationPromptInput = {
      currentDate: "2026-04-08",
      timezone: "UTC",
      sharedMemoryCurrent: "# Preferences\n\n- Prefer concise updates.\n",
      agentContexts: [
        {
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recently fixing frontend regressions.",
          privateMemoryCurrent: "# Scope\n\n- atlas-web frontend.\n",
          bucketNote: "This SubAgent repeatedly delayed the diagnosis and frustrated the user.",
          memoryCandidates: [
            "For atlas-web frontend debugging, lead with diagnosis before explanation.",
          ],
        },
      ],
      recentMeditationExcerpts: [
        {
          date: "2026-04-07",
          text: "Another run surfaced the same friction around long explanations before diagnosis.",
        },
      ],
    };

    const result = await runMeditationConsolidationAgent({
      bridge: {
        async completeTurn(input) {
          expect(input.systemPrompt).toContain("Promotion is optional.");
          expect(input.messages).toHaveLength(1);
          expect(input.messages[0]?.payloadJson).toContain("Prefer concise updates.");
          return createTurnResult({
            shared_memory_rewrite:
              "# Preferences\n\n- Prefer concise updates.\n\n# Working Conventions\n\n- Lead with diagnosis before explanation when the user is debugging.\n",
            private_memory_rewrites: [
              {
                agent_id: "agent_sub_1",
                content:
                  "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
              },
            ],
          });
        },
      },
      model: createModel(),
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      promptInput,
    });

    expect(result.systemPrompt).toContain("When in doubt, preserve the specific constant.");
    expect(result.prompt).toContain("<shared_memory_current>");
    expect(result.prompt).toContain("Atlas Frontend");
    expect(result.submission).toEqual({
      shared_memory_rewrite:
        "# Preferences\n\n- Prefer concise updates.\n\n# Working Conventions\n\n- Lead with diagnosis before explanation when the user is debugging.\n",
      private_memory_rewrites: [
        {
          agent_id: "agent_sub_1",
          content:
            "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
        },
      ],
    });
    expect(result.turns[0]?.content[0]).toMatchObject({
      type: "thinking",
    });
  });
});
