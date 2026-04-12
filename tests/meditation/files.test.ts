import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildMeditationDailyNotePath,
  buildMeditationRunArtifactDir,
  buildMeditationWorkspaceDir,
  ensureMeditationRunArtifactDir,
  writeMeditationTextFileAtomic,
} from "@/src/meditation/files.js";

describe("meditation files", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("builds stable workspace and run artifact paths", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-files-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const logsDir = path.join(tempDir, "logs");

    expect(buildMeditationWorkspaceDir(workspaceDir)).toBe(path.join(workspaceDir, "meditation"));
    expect(buildMeditationDailyNotePath("2026-04-08", workspaceDir)).toBe(
      path.join(workspaceDir, "meditation", "2026-04-08.md"),
    );
    expect(buildMeditationRunArtifactDir("2026-04-08", "run_123", logsDir)).toBe(
      path.join(logsDir, "meditation", "2026-04-08--run_123"),
    );
  });

  test("ensures run artifact dir and writes files atomically", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-meditation-files-"));
    const logsDir = path.join(tempDir, "logs");
    const artifactDir = await ensureMeditationRunArtifactDir("2026-04-08", "run_123", logsDir);

    const filePath = path.join(artifactDir, "note.md");
    await writeMeditationTextFileAtomic(filePath, "# hello\n");

    expect(artifactDir).toBe(path.join(logsDir, "meditation", "2026-04-08--run_123"));
    await expect(readFile(filePath, "utf8")).resolves.toBe("# hello\n");
  });
});
