import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  appendMeditationDailyRunBlock,
  buildMeditationDailyRunBlock,
} from "@/src/meditation/daily-note.js";

describe("meditation daily note", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("builds a run block that keeps bucket notes and rewrite summary", () => {
    const block = buildMeditationDailyRunBlock({
      runId: "run_test",
      tickAt: "2026-04-08T00:00:00.000Z",
      localDate: "2026-04-08",
      timezone: "UTC",
      windowStart: "2026-04-01T00:00:00.000Z",
      windowEnd: "2026-04-08T00:00:00.000Z",
      bucketModelId: "openai_main/gpt-5-mini",
      consolidationModelId: "openai_main/gpt-5",
      buckets: [
        {
          bucketId: "agent_sub_1",
          agentId: "agent_sub_1",
          displayName: "Atlas Frontend",
          note: "The user clearly wanted diagnosis before explanation.",
          memoryCandidates: [
            "For atlas-web frontend debugging, lead with diagnosis before explanation.",
          ],
        },
      ],
      consolidationSummary: {
        sharedRewritten: true,
        privateRewrittenAgentIds: ["agent_sub_1"],
      },
    });

    expect(block).toContain("# Meditation 2026-04-08");
    expect(block).toContain("## Run run_test");
    expect(block).toContain("Atlas Frontend");
    expect(block).toContain("diagnosis before explanation");
    expect(block).toContain("Shared memory rewritten: yes");
    expect(block).toContain("Private memory rewrites:");
  });

  test("appends multiple run blocks into the same daily note file", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-daily-note-"));
    const workspaceDir = path.join(tempDir, "workspace");

    await appendMeditationDailyRunBlock({
      localDate: "2026-04-08",
      workspaceDir,
      runBlock: "# Meditation 2026-04-08\n\n## Run run_1\n\nfirst block\n",
    });
    await appendMeditationDailyRunBlock({
      localDate: "2026-04-08",
      workspaceDir,
      runBlock: "## Run run_2\n\nsecond block\n",
    });

    const content = await readFile(path.join(workspaceDir, "meditation", "2026-04-08.md"), "utf8");

    expect(content).toContain("## Run run_1");
    expect(content).toContain("## Run run_2");
    expect(content).toContain("\n\n---\n\n");
  });
});
