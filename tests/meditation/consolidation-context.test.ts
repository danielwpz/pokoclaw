import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildMeditationConsolidationRewritePromptInput,
  loadMeditationConsolidationEvaluationPromptInput,
  validateConsolidationEvaluations,
} from "@/src/meditation/consolidation-context.js";
import { buildMeditationFindingId } from "@/src/meditation/prompts.js";

describe("meditation consolidation context", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("loads touched private memory, shared memory, same-agent recent history, and shared bucket packets", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-consolidation-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const logsDir = path.join(tempDir, "logs");
    const previousRunDir = path.join(logsDir, "meditation", "2026-04-07--run_prev");
    const privateWorkspaceDir = path.join(workspaceDir, "subagents", "agentsub");
    await mkdir(previousRunDir, { recursive: true });
    await mkdir(privateWorkspaceDir, { recursive: true });

    await writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Preferences\n\n- Prefer concise updates.\n",
      "utf8",
    );
    await writeFile(
      path.join(privateWorkspaceDir, "MEMORY.md"),
      "# Scope\n\n- atlas-web frontend.\n",
      "utf8",
    );
    await writeFile(
      path.join(previousRunDir, "bucket-inputs.json"),
      JSON.stringify([{ bucketId: "bucket_prev_1", agentId: "agent_sub_1" }], null, 2),
      "utf8",
    );
    await writeFile(
      path.join(previousRunDir, "bucket-bucket_prev_1.submit.json"),
      JSON.stringify(
        {
          note: "Observed the same diagnosis-first friction.",
          findings: [
            {
              summary: "The same diagnosis-first friction happened yesterday.",
              issue_type: "user_preference_signal",
              scope_hint: "subagent",
              cluster_ids: ["stop:prev"],
              evidence_summary: "The user redirected the response style in yesterday's run.",
              examples: ["user quote: lead with the diagnosis first"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const promptInput = await loadMeditationConsolidationEvaluationPromptInput({
      currentDate: "2026-04-08",
      currentRunId: "run_current",
      timezone: "UTC",
      workspaceDir,
      logsDir,
      buckets: [
        {
          bucketId: "bucket_current_1",
          agentId: "agent_sub_1",
          profile: {
            agentId: "agent_sub_1",
            kind: "sub",
            displayName: "Atlas Frontend",
            description: "Handles atlas-web frontend tasks.",
            workdir: "/repo/atlas-web",
            compactSummary: "Recently fixing frontend regressions.",
          },
          note: "The user clearly wanted diagnosis before explanation.",
          findings: [
            {
              summary: "For atlas-web frontend debugging, lead with diagnosis before explanation.",
              issue_type: "user_preference_signal",
              scope_hint: "subagent",
              cluster_ids: ["stop:1"],
              evidence_summary: "The user stopped the run and asked for diagnosis first.",
              examples: ["user quote: lead with the diagnosis first"],
            },
          ],
        },
        {
          bucketId: "bucket_main_1",
          agentId: "agent_main_1",
          profile: {
            agentId: "agent_main_1",
            kind: "main",
            displayName: "Pokoclaw Main Agent",
            description: "Owns the main user conversation.",
            workdir: "/repo/pokoclaw",
            compactSummary: null,
          },
          note: "The main agent also hit repeated permission loops.",
          findings: [
            {
              summary: "Avoid repeating the same denied permission request.",
              issue_type: "agent_workflow_issue",
              scope_hint: "shared",
              cluster_ids: ["tool_repeat:1"],
              evidence_summary: "The main agent repeated the same permission request.",
              examples: ["tool error: Permission request denied."],
            },
          ],
        },
        {
          bucketId: "bucket_shared_1",
          agentId: null,
          profile: null,
          note: "Shared user friction around long explanations.",
          findings: [
            {
              summary: "Lead with the likely diagnosis before a long explanation.",
              issue_type: "user_preference_signal",
              scope_hint: "shared",
              cluster_ids: ["stop:shared-1"],
              evidence_summary:
                "A shared user-facing friction showed up outside one specific subagent.",
              examples: ["user quote: lead with the likely diagnosis first"],
            },
          ],
        },
      ],
    });

    expect(promptInput.sharedMemoryCurrent).toContain("Prefer concise updates.");
    expect(promptInput.bucketPackets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucketId: "bucket_current_1",
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          privateMemoryCurrent: expect.stringContaining("atlas-web frontend"),
          bucketNote: "The user clearly wanted diagnosis before explanation.",
          currentFindings: [
            expect.objectContaining({
              findingId: buildMeditationFindingId("bucket_current_1", 0),
              summary: "For atlas-web frontend debugging, lead with diagnosis before explanation.",
            }),
          ],
          recentHistory: [
            expect.objectContaining({
              date: "2026-04-07",
              runId: "run_prev",
              summary: "The same diagnosis-first friction happened yesterday.",
            }),
          ],
          recentHistoryStats: {
            daysWithFindings: 1,
            totalFindings: 1,
            countsByIssueType: {
              user_preference_signal: 1,
            },
          },
        }),
        expect.objectContaining({
          bucketId: "bucket_main_1",
          agentId: "agent_main_1",
          agentKind: "main",
          displayName: "Pokoclaw Main Agent",
          privateMemoryCurrent: null,
          bucketNote: "The main agent also hit repeated permission loops.",
          currentFindings: [
            expect.objectContaining({
              findingId: buildMeditationFindingId("bucket_main_1", 0),
              summary: "Avoid repeating the same denied permission request.",
            }),
          ],
        }),
        expect.objectContaining({
          bucketId: "bucket_shared_1",
          agentId: "shared",
          agentKind: "shared",
          displayName: "Shared Findings",
          privateMemoryCurrent: null,
          currentFindings: [
            expect.objectContaining({
              findingId: buildMeditationFindingId("bucket_shared_1", 0),
              scopeHint: "shared",
            }),
          ],
        }),
      ]),
    );

    const rewritePromptInput = buildMeditationConsolidationRewritePromptInput({
      evaluationPromptInput: promptInput,
      evaluation: {
        evaluations: [
          {
            finding_id: buildMeditationFindingId("bucket_current_1", 0),
            priority: "high",
            durability: "durable",
            promotion_decision: "private_memory",
            reason: "This keeps repeating in atlas-web frontend work.",
          },
          {
            finding_id: buildMeditationFindingId("bucket_main_1", 0),
            priority: "high",
            durability: "durable",
            promotion_decision: "shared_memory",
            reason: "This should influence shared coordination behavior.",
          },
          {
            finding_id: buildMeditationFindingId("bucket_shared_1", 0),
            priority: "high",
            durability: "durable",
            promotion_decision: "shared_memory",
            reason: "This is clearly shared behavior guidance.",
          },
        ],
      },
    });

    expect(rewritePromptInput.approvedSharedFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: buildMeditationFindingId("bucket_main_1", 0),
          promotionDecision: "shared_memory",
        }),
        expect.objectContaining({
          findingId: buildMeditationFindingId("bucket_shared_1", 0),
          promotionDecision: "shared_memory",
        }),
      ]),
    );
    expect(rewritePromptInput.bucketPackets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucketId: "bucket_current_1",
          approvedPrivateFindings: [
            expect.objectContaining({
              findingId: buildMeditationFindingId("bucket_current_1", 0),
              promotionDecision: "private_memory",
            }),
          ],
        }),
      ]),
    );
  });

  test("keeps buckets even when the agent profile cannot be resolved", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-consolidation-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Preferences\n\n- Prefer concise updates.\n",
      "utf8",
    );

    const promptInput = await loadMeditationConsolidationEvaluationPromptInput({
      currentDate: "2026-04-08",
      currentRunId: "run_current",
      timezone: "UTC",
      workspaceDir,
      buckets: [
        {
          bucketId: "bucket_unknown_1",
          agentId: "agent_unknown_1",
          profile: null,
          note: "Repeated friction with missing agent profile.",
          findings: [
            {
              summary: "Do not repeat the same denied permission request.",
              issue_type: "agent_workflow_issue",
              scope_hint: "shared",
              cluster_ids: ["tool_repeat:1"],
              evidence_summary: "The same permission request repeated in one run.",
              examples: ["tool error: Permission request denied."],
            },
          ],
        },
      ],
    });

    expect(promptInput.bucketPackets).toEqual([
      expect.objectContaining({
        bucketId: "bucket_unknown_1",
        agentId: "agent_unknown_1",
        agentKind: "unknown",
        displayName: null,
        privateMemoryCurrent: null,
        currentFindings: [
          expect.objectContaining({
            findingId: buildMeditationFindingId("bucket_unknown_1", 0),
          }),
        ],
      }),
    ]);
  });

  test("requires evaluation coverage for every current finding", async () => {
    expect(() =>
      validateConsolidationEvaluations({
        bucketPackets: [
          {
            bucketId: "bucket_sub_1",
            agentId: "agent_sub_1",
            agentKind: "sub",
            displayName: "Atlas Frontend",
            description: null,
            workdir: null,
            compactSummary: null,
            privateMemoryCurrent: null,
            bucketNote: "note",
            currentFindings: [
              {
                findingId: buildMeditationFindingId("bucket_sub_1", 0),
                summary: "first",
                issueType: "user_preference_signal",
                scopeHint: "subagent",
                clusterIds: [],
                evidenceSummary: "e1",
                examples: ["example 1"],
              },
              {
                findingId: buildMeditationFindingId("bucket_sub_1", 1),
                summary: "second",
                issueType: "agent_workflow_issue",
                scopeHint: "subagent",
                clusterIds: [],
                evidenceSummary: "e2",
                examples: ["example 2"],
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
        evaluation: {
          evaluations: [
            {
              finding_id: buildMeditationFindingId("bucket_sub_1", 0),
              priority: "high",
              durability: "durable",
              promotion_decision: "private_memory",
              reason: "ok",
            },
          ],
        },
      }),
    ).toThrow("did not cover all current findings");
  });

  test("rejects private promotion decisions for non-sub packets", async () => {
    expect(() =>
      validateConsolidationEvaluations({
        bucketPackets: [
          {
            bucketId: "bucket_shared_1",
            agentId: "shared",
            agentKind: "shared",
            displayName: "Shared Findings",
            description: null,
            workdir: null,
            compactSummary: null,
            privateMemoryCurrent: null,
            bucketNote: "note",
            currentFindings: [
              {
                findingId: buildMeditationFindingId("bucket_shared_1", 0),
                summary: "shared finding",
                issueType: "user_preference_signal",
                scopeHint: "shared",
                clusterIds: [],
                evidenceSummary: "e1",
                examples: ["example 1"],
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
        evaluation: {
          evaluations: [
            {
              finding_id: buildMeditationFindingId("bucket_shared_1", 0),
              priority: "high",
              durability: "durable",
              promotion_decision: "private_memory",
              reason: "not allowed",
            },
          ],
        },
      }),
    ).toThrow("cannot target private_memory for non-sub packet");
  });

  test("keeps medium recurring promotions out of rewrite input", () => {
    const rewritePromptInput = buildMeditationConsolidationRewritePromptInput({
      evaluationPromptInput: {
        currentDate: "2026-04-08",
        timezone: "UTC",
        sharedMemoryCurrent: "# Shared Memory\n",
        bucketPackets: [
          {
            bucketId: "bucket_sub_1",
            agentId: "agent_sub_1",
            agentKind: "sub",
            displayName: "Atlas Frontend",
            description: null,
            workdir: null,
            compactSummary: null,
            privateMemoryCurrent: "# Private Memory\n",
            bucketNote: "note",
            currentFindings: [
              {
                findingId: buildMeditationFindingId("bucket_sub_1", 0),
                summary: "first",
                issueType: "tool_or_source_quirk",
                scopeHint: "subagent",
                clusterIds: [],
                evidenceSummary: "e1",
                examples: ["example 1"],
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
      },
      evaluation: {
        evaluations: [
          {
            finding_id: buildMeditationFindingId("bucket_sub_1", 0),
            priority: "medium",
            durability: "recurring",
            promotion_decision: "private_memory",
            reason: "not strong enough yet",
          },
        ],
      },
    });

    expect(rewritePromptInput.approvedSharedFindings).toEqual([]);
    expect(rewritePromptInput.bucketPackets).toEqual([]);
  });

  test("filters structurally ineligible promotions even when evaluation approves them", () => {
    const rewritePromptInput = buildMeditationConsolidationRewritePromptInput({
      evaluationPromptInput: {
        currentDate: "2026-04-08",
        timezone: "UTC",
        sharedMemoryCurrent: "# Shared Memory\n",
        bucketPackets: [
          {
            bucketId: "bucket_sub_1",
            agentId: "agent_sub_1",
            agentKind: "sub",
            displayName: "Atlas Frontend",
            description: null,
            workdir: null,
            compactSummary: null,
            privateMemoryCurrent: "# Private Memory\n",
            bucketNote: "note",
            currentFindings: [
              {
                findingId: buildMeditationFindingId("bucket_sub_1", 0),
                summary: "subagent scoped tool quirk",
                issueType: "tool_or_source_quirk",
                scopeHint: "subagent",
                clusterIds: [],
                evidenceSummary: "e1",
                examples: ["example 1"],
              },
              {
                findingId: buildMeditationFindingId("bucket_sub_1", 1),
                summary: "shared-looking system issue",
                issueType: "system_or_config_issue",
                scopeHint: "shared",
                clusterIds: [],
                evidenceSummary: "e2",
                examples: ["example 2"],
              },
              {
                findingId: buildMeditationFindingId("bucket_sub_1", 2),
                summary: "session-only preference signal",
                issueType: "user_preference_signal",
                scopeHint: "session_only",
                clusterIds: [],
                evidenceSummary: "e3",
                examples: ["example 3"],
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
      },
      evaluation: {
        evaluations: [
          {
            finding_id: buildMeditationFindingId("bucket_sub_1", 0),
            priority: "high",
            durability: "durable",
            promotion_decision: "private_memory",
            reason: "ok",
          },
          {
            finding_id: buildMeditationFindingId("bucket_sub_1", 1),
            priority: "high",
            durability: "durable",
            promotion_decision: "shared_memory",
            reason: "should be blocked by host-side eligibility",
          },
          {
            finding_id: buildMeditationFindingId("bucket_sub_1", 2),
            priority: "high",
            durability: "durable",
            promotion_decision: "shared_memory",
            reason: "should be blocked by session-only scope",
          },
        ],
      },
    });

    expect(rewritePromptInput.approvedSharedFindings).toEqual([]);
    expect(rewritePromptInput.bucketPackets).toEqual([
      expect.objectContaining({
        bucketId: "bucket_sub_1",
        approvedPrivateFindings: [
          expect.objectContaining({
            findingId: buildMeditationFindingId("bucket_sub_1", 0),
            promotionDecision: "private_memory",
          }),
        ],
      }),
    ]);
  });
});
