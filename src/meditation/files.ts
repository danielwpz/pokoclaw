/**
 * Filesystem helpers for meditation outputs.
 *
 * Separates durable daily notes (workspace) from debug artifacts (logs), and
 * provides atomic write helpers to avoid partial file states.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { POKOCLAW_LOGS_DIR, POKOCLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";

export const MEDITATION_DIRNAME = "meditation";

export function buildMeditationWorkspaceDir(workspaceDir = POKOCLAW_WORKSPACE_DIR): string {
  return path.resolve(workspaceDir, MEDITATION_DIRNAME);
}

export function buildMeditationDailyNotePath(
  localDate: string,
  workspaceDir = POKOCLAW_WORKSPACE_DIR,
): string {
  return path.join(buildMeditationWorkspaceDir(workspaceDir), `${localDate}.md`);
}

export function buildMeditationLogsRoot(logsDir = POKOCLAW_LOGS_DIR): string {
  return path.resolve(logsDir, MEDITATION_DIRNAME);
}

export function buildMeditationRunArtifactDir(
  localDate: string,
  runId: string,
  logsDir = POKOCLAW_LOGS_DIR,
): string {
  return path.join(buildMeditationLogsRoot(logsDir), `${localDate}--${runId}`);
}

export async function ensureMeditationWorkspaceDir(
  workspaceDir = POKOCLAW_WORKSPACE_DIR,
): Promise<void> {
  await mkdir(buildMeditationWorkspaceDir(workspaceDir), { recursive: true });
}

export async function ensureMeditationRunArtifactDir(
  localDate: string,
  runId: string,
  logsDir = POKOCLAW_LOGS_DIR,
): Promise<string> {
  const artifactDir = buildMeditationRunArtifactDir(localDate, runId, logsDir);
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
}

export async function writeMeditationTextFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const normalizedPath = path.resolve(filePath);
  const dir = path.dirname(normalizedPath);
  await mkdir(dir, { recursive: true });

  const tempPath = path.join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, normalizedPath);
}
