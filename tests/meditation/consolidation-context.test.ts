import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadMeditationConsolidationPromptInput } from "@/src/meditation/consolidation-context.js";

describe("meditation consolidation context", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("loads touched private memory, shared memory, and recent meditation excerpts", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-meditation-consolidation-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const meditationDir = path.join(workspaceDir, "meditation");
    const privateWorkspaceDir = path.join(workspaceDir, "subagents", "agentsub");
    await mkdir(meditationDir, { recursive: true });
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
      path.join(meditationDir, "2026-04-07.md"),
      "# Meditation 2026-04-07\n\nObserved the same diagnosis-first friction.\n",
      "utf8",
    );
    await writeFile(
      path.join(meditationDir, "2026-03-20.md"),
      "# Meditation 2026-03-20\n\nToo old and should be ignored.\n",
      "utf8",
    );

    const promptInput = await loadMeditationConsolidationPromptInput({
      currentDate: "2026-04-08",
      timezone: "UTC",
      workspaceDir,
      buckets: [
        {
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
          memoryCandidates: [
            "For atlas-web frontend debugging, lead with diagnosis before explanation.",
          ],
        },
        {
          agentId: "agent_main_1",
          profile: {
            agentId: "agent_main_1",
            kind: "main",
            displayName: "Pokeclaw Main Agent",
            description: "Owns the main user conversation.",
            workdir: "/repo/pokeclaw",
            compactSummary: null,
          },
          note: "The main agent also hit repeated permission loops.",
          memoryCandidates: ["Avoid repeating the same denied permission request."],
        },
        {
          agentId: null,
          profile: null,
          note: "Shared user friction around long explanations.",
          memoryCandidates: ["Lead with the likely diagnosis before a long explanation."],
        },
      ],
    });

    expect(promptInput.sharedMemoryCurrent).toContain("Prefer concise updates.");
    expect(promptInput.agentContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "agent_sub_1",
          agentKind: "sub",
          displayName: "Atlas Frontend",
          privateMemoryCurrent: expect.stringContaining("atlas-web frontend"),
          bucketNote: "The user clearly wanted diagnosis before explanation.",
          memoryCandidates: [
            "For atlas-web frontend debugging, lead with diagnosis before explanation.",
          ],
        }),
        expect.objectContaining({
          agentId: "agent_main_1",
          agentKind: "main",
          displayName: "Pokeclaw Main Agent",
          privateMemoryCurrent: null,
          bucketNote: "The main agent also hit repeated permission loops.",
          memoryCandidates: ["Avoid repeating the same denied permission request."],
        }),
      ]),
    );
    expect(promptInput.recentMeditationExcerpts).toEqual([
      expect.objectContaining({
        date: "2026-04-07",
        text: expect.stringContaining("diagnosis-first friction"),
      }),
    ]);
  });

  test("skips buckets whose agent profile cannot be resolved", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-meditation-consolidation-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Preferences\n\n- Prefer concise updates.\n",
      "utf8",
    );

    const promptInput = await loadMeditationConsolidationPromptInput({
      currentDate: "2026-04-08",
      timezone: "UTC",
      workspaceDir,
      buckets: [
        {
          agentId: "agent_unknown_1",
          profile: null,
          note: "Repeated friction with missing agent profile.",
          memoryCandidates: ["Do not repeat the same denied permission request."],
        },
      ],
    });

    expect(promptInput.agentContexts).toEqual([]);
  });
});
