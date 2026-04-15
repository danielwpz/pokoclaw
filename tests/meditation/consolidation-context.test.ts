import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildMeditationConsolidationRewritePromptInput,
  loadMeditationConsolidationEvaluationPromptInput,
} from "@/src/meditation/consolidation-context.js";

describe("meditation consolidation context", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("loads touched private memory, shared memory, and same-agent recent history", async () => {
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
            },
          ],
        },
        {
          bucketId: "bucket_shared_1",
          agentId: null,
          profile: null,
          note: "Shared user friction around long explanations.",
          findings: [],
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
              findingId: "bucket_current_1/finding-1",
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
              findingId: "bucket_main_1/finding-1",
              summary: "Avoid repeating the same denied permission request.",
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
            finding_id: "bucket_current_1/finding-1",
            priority: "high",
            durability: "durable",
            promotion_decision: "private_memory",
            reason: "This keeps repeating in atlas-web frontend work.",
          },
          {
            finding_id: "bucket_main_1/finding-1",
            priority: "medium",
            durability: "recurring",
            promotion_decision: "shared_memory",
            reason: "This should influence shared coordination behavior.",
          },
        ],
      },
    });

    expect(rewritePromptInput.bucketPackets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucketId: "bucket_current_1",
          approvedFindings: [
            expect.objectContaining({
              findingId: "bucket_current_1/finding-1",
              promotionDecision: "private_memory",
            }),
          ],
        }),
        expect.objectContaining({
          bucketId: "bucket_main_1",
          approvedFindings: [
            expect.objectContaining({
              findingId: "bucket_main_1/finding-1",
              promotionDecision: "shared_memory",
            }),
          ],
        }),
      ]),
    );
  });

  test("skips buckets whose agent profile cannot be resolved", async () => {
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
            },
          ],
        },
      ],
    });

    expect(promptInput.bucketPackets).toEqual([]);
  });
});
