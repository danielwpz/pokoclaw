import { afterEach, describe, expect, test } from "vitest";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { PiBridgeRunTurnResult } from "@/src/agent/llm/pi-bridge.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import {
  runMeditationBucketAgent,
  runMeditationConsolidationEvaluationAgent,
  runMeditationConsolidationRewriteAgent,
} from "@/src/meditation/agent-runner.js";
import type { PreparedMeditationBucket } from "@/src/meditation/bucket-prep.js";
import type {
  MeditationConsolidationEvaluationPromptInput,
  MeditationConsolidationRewritePromptInput,
} from "@/src/meditation/prompts.js";
import { buildMeditationFindingId } from "@/src/meditation/prompts.js";
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
            findings: [
              {
                summary:
                  "For atlas-web frontend debugging, the user wanted the likely diagnosis before a long explanation.",
                issue_type: "user_preference_signal",
                scope_hint: "subagent",
                cluster_ids: ["stop:1"],
                evidence_summary: "The user message redirected the response style.",
                examples: ["user quote: lead with the diagnosis first"],
              },
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
      findings: [
        {
          summary:
            "For atlas-web frontend debugging, the user wanted the likely diagnosis before a long explanation.",
          issue_type: "user_preference_signal",
          scope_hint: "subagent",
          cluster_ids: ["stop:1"],
          evidence_summary: "The user message redirected the response style.",
          examples: ["user quote: lead with the diagnosis first"],
        },
      ],
    });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.content[0]).toMatchObject({
      type: "thinking",
    });
  });

  test("runs consolidation evaluation with explicit judgments", async () => {
    handle = await createTestDatabase(import.meta.url);

    const promptInput: MeditationConsolidationEvaluationPromptInput = {
      currentDate: "2026-04-08",
      timezone: "UTC",
      sharedMemoryCurrent: "# Preferences\n\n- Prefer concise updates.\n",
      bucketPackets: [
        {
          bucketId: "bucket_sub_1",
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recently fixing frontend regressions.",
          privateMemoryCurrent: "# Scope\n\n- atlas-web frontend.\n",
          bucketNote: "This SubAgent repeatedly delayed the diagnosis and frustrated the user.",
          currentFindings: [
            {
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
              summary: "For atlas-web frontend debugging, lead with diagnosis before explanation.",
              issueType: "user_preference_signal",
              scopeHint: "subagent",
              clusterIds: ["stop:1"],
              evidenceSummary: "The user interrupted the run and asked for diagnosis first.",
              examples: ["user quote: lead with the diagnosis first"],
            },
          ],
          recentHistory: [
            {
              date: "2026-04-07",
              runId: "run_prev",
              summary: "Yesterday's run hit the same response-style friction.",
              issueType: "user_preference_signal",
              scopeHint: "subagent",
              evidenceSummary: "A previous run showed the same redirect.",
            },
          ],
          recentHistoryStats: {
            daysWithFindings: 1,
            totalFindings: 1,
            countsByIssueType: {
              user_preference_signal: 1,
            },
          },
        },
      ],
    };

    const result = await runMeditationConsolidationEvaluationAgent({
      bridge: {
        async completeTurn(input) {
          expect(input.systemPrompt).toContain("This evaluation step is the judgment layer.");
          expect(input.messages).toHaveLength(1);
          expect(input.messages[0]?.payloadJson).toContain("Prefer concise updates.");
          return createTurnResult({
            evaluations: [
              {
                finding_id: buildMeditationFindingId("bucket_sub_1", 0),
                priority: "high",
                durability: "durable",
                promotion_decision: "private_memory",
                reason: "This keeps repeating in atlas-web frontend work.",
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

    expect(result.systemPrompt).toContain("This evaluation step is the judgment layer.");
    expect(result.prompt).toContain("Atlas Frontend");
    expect(result.submission).toEqual({
      evaluations: [
        {
          finding_id: buildMeditationFindingId("bucket_sub_1", 0),
          priority: "high",
          durability: "durable",
          promotion_decision: "private_memory",
          reason: "This keeps repeating in atlas-web frontend work.",
        },
      ],
    });
    expect(result.turns[0]?.content[0]).toMatchObject({
      type: "thinking",
    });
  });

  test("runs consolidation rewrite from approved findings", async () => {
    handle = await createTestDatabase(import.meta.url);

    const promptInput: MeditationConsolidationRewritePromptInput = {
      currentDate: "2026-04-08",
      timezone: "UTC",
      sharedMemoryCurrent: "# Preferences\n\n- Prefer concise updates.\n",
      approvedSharedFindings: [],
      bucketPackets: [
        {
          bucketId: "bucket_sub_1",
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recently fixing frontend regressions.",
          privateMemoryCurrent: "# Scope\n\n- atlas-web frontend.\n",
          approvedPrivateFindings: [
            {
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
              agentId: "agent_sub_1",
              agentKind: "sub",
              priority: "high",
              durability: "durable",
              promotionDecision: "private_memory",
              reason: "This keeps repeating in atlas-web frontend work.",
              summary: "For atlas-web frontend debugging, lead with diagnosis before explanation.",
              issueType: "user_preference_signal",
              scopeHint: "subagent",
              evidenceSummary: "The user interrupted the run and asked for diagnosis first.",
              examples: ["user quote: lead with the diagnosis first"],
            },
          ],
        },
      ],
    };

    const result = await runMeditationConsolidationRewriteAgent({
      bridge: {
        async completeTurn(input) {
          expect(input.systemPrompt).toContain("Do not reevaluate the world from scratch.");
          expect(input.messages[0]?.payloadJson).toContain("approved findings");
          expect(input.systemPrompt).toContain("rewritten markdown");
          return createTurnResult({
            shared_rewrite: null,
            private_rewrites: [
              {
                agent_id: "agent_sub_1",
                lessons: [
                  {
                    rule_text:
                      "Lead with diagnosis before explanation during atlas-web frontend debugging.",
                    supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
                    why_generalizable:
                      "This is a stable future-facing collaboration rule for this subagent.",
                    evidence_examples: ["user quote: lead with the diagnosis first"],
                  },
                ],
                rewritten_markdown:
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

    expect(result.submission).toEqual({
      shared_rewrite: null,
      private_rewrites: [
        {
          agent_id: "agent_sub_1",
          lessons: [
            {
              rule_text:
                "Lead with diagnosis before explanation during atlas-web frontend debugging.",
              supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
              why_generalizable:
                "This is a stable future-facing collaboration rule for this subagent.",
              evidence_examples: ["user quote: lead with the diagnosis first"],
            },
          ],
          rewritten_markdown:
            "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
        },
      ],
    });
  });

  test("retries consolidation rewrite when rewritten markdown is too short", async () => {
    handle = await createTestDatabase(import.meta.url);
    let turn = 0;

    const promptInput: MeditationConsolidationRewritePromptInput = {
      currentDate: "2026-04-08",
      timezone: "UTC",
      sharedMemoryCurrent: "# Preferences\n\n- Prefer concise updates.\n",
      approvedSharedFindings: [],
      bucketPackets: [
        {
          bucketId: "bucket_sub_1",
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          description: "Handles atlas-web frontend tasks.",
          workdir: "/repo/atlas-web",
          compactSummary: "Recently fixing frontend regressions.",
          privateMemoryCurrent:
            "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Keep using the shared diagnosis-first rule.\n",
          approvedPrivateFindings: [
            {
              findingId: buildMeditationFindingId("bucket_sub_1", 0),
              agentId: "agent_sub_1",
              agentKind: "sub",
              priority: "high",
              durability: "durable",
              promotionDecision: "private_memory",
              reason: "This keeps repeating in atlas-web frontend work.",
              summary: "For atlas-web frontend debugging, lead with diagnosis before explanation.",
              issueType: "user_preference_signal",
              scopeHint: "subagent",
              evidenceSummary: "The user interrupted the run and asked for diagnosis first.",
              examples: ["user quote: lead with the diagnosis first"],
            },
          ],
        },
      ],
    };

    const result = await runMeditationConsolidationRewriteAgent({
      bridge: {
        async completeTurn(input) {
          turn += 1;
          if (turn === 1) {
            return createTurnResult({
              shared_rewrite: null,
              private_rewrites: [
                {
                  agent_id: "agent_sub_1",
                  lessons: [
                    {
                      rule_text:
                        "Lead with diagnosis before explanation during atlas-web frontend debugging.",
                      supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
                      why_generalizable:
                        "This is a stable future-facing collaboration rule for this subagent.",
                      evidence_examples: ["user quote: lead with the diagnosis first"],
                    },
                  ],
                  rewritten_markdown: "Too short.\n",
                },
              ],
            });
          }

          expect(input.messages.some((message) => message.payloadJson.includes("too short"))).toBe(
            true,
          );
          return createTurnResult({
            shared_rewrite: null,
            private_rewrites: [
              {
                agent_id: "agent_sub_1",
                lessons: [
                  {
                    rule_text:
                      "Lead with diagnosis before explanation during atlas-web frontend debugging.",
                    supported_finding_ids: [buildMeditationFindingId("bucket_sub_1", 0)],
                    why_generalizable:
                      "This is a stable future-facing collaboration rule for this subagent.",
                    evidence_examples: ["user quote: lead with the diagnosis first"],
                  },
                ],
                rewritten_markdown:
                  "# Scope\n\n- atlas-web frontend.\n\n# Repeat-Use Lessons\n\n- Keep using the shared diagnosis-first rule.\n- Lead with diagnosis before explanation during atlas-web frontend debugging.\n",
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

    expect(turn).toBe(2);
    expect(result.submission.private_rewrites[0]?.rewritten_markdown).toContain(
      "Lead with diagnosis before explanation during atlas-web frontend debugging.",
    );
  });
});
