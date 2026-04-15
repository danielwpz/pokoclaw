import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { SecurityConfig } from "@/src/config/schema.js";
import { buildMeditationLogsRoot, buildMeditationWorkspaceDir } from "@/src/meditation/files.js";
import type { MeditationRunRequest } from "@/src/meditation/scheduler.js";
import {
  DEFAULT_MEDITATION_LOOKBACK_DAYS,
  type MeditationWindow,
  resolveMeditationWindow,
} from "@/src/meditation/window.js";
import { buildWorkspaceSharedMemoryPath } from "@/src/memory/files.js";
import {
  POKOCLAW_HOME_DIR,
  POKOCLAW_LOGS_DIR,
  POKOCLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";
import {
  type LocalCalendarContext,
  resolveLocalCalendarContext,
  toCanonicalUtcIsoTimestamp,
} from "@/src/shared/time.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";

export interface MeditationBacktestWindowInput {
  tickAt: Date;
  startAt?: Date;
  endAt?: Date;
  lastSuccessAt?: string | null;
  lookbackDays?: number;
  calendarContext?: LocalCalendarContext;
}

export interface MeditationBacktestSandboxPaths {
  rootDir: string;
  workspaceDir: string;
  logsDir: string;
  databasePath: string;
}

export interface BuildMeditationBacktestSecurityConfigInput {
  securityConfig: SecurityConfig;
  sourceWorkspaceDir?: string;
  sourceLogsDir?: string;
  sourceDatabasePath?: string;
}

export function buildMeditationBacktestRunRequest(
  input: MeditationBacktestWindowInput,
): MeditationRunRequest {
  return {
    tickAt: input.tickAt,
    windowOverride: buildMeditationBacktestWindow(input),
  };
}

export function buildMeditationBacktestWindow(
  input: MeditationBacktestWindowInput,
): MeditationWindow {
  const calendarContext = input.calendarContext ?? resolveLocalCalendarContext(input.tickAt);
  const endAt = input.endAt ?? input.tickAt;
  if (Number.isNaN(endAt.getTime())) {
    throw new Error("Backtest endAt is invalid.");
  }

  if (input.startAt != null) {
    if (Number.isNaN(input.startAt.getTime())) {
      throw new Error("Backtest startAt is invalid.");
    }
    if (input.startAt.getTime() > endAt.getTime()) {
      throw new Error("Backtest startAt must be earlier than or equal to endAt.");
    }

    return {
      startAt: toCanonicalUtcIsoTimestamp(input.startAt),
      endAt: toCanonicalUtcIsoTimestamp(endAt),
      lastSuccessAt: input.lastSuccessAt ?? null,
      localDate: calendarContext.currentDate,
      timezone: calendarContext.timezone,
      clippedByLookback: false,
    };
  }

  return resolveMeditationWindow({
    tickAt: endAt,
    lastSuccessAt: input.lastSuccessAt ?? null,
    maxLookbackDays: input.lookbackDays ?? DEFAULT_MEDITATION_LOOKBACK_DAYS,
    calendarContext,
  });
}

export function buildDefaultMeditationBacktestSandboxPaths(input: {
  label: string;
  cwd?: string;
}): MeditationBacktestSandboxPaths {
  const rootDir = path.join(
    input.cwd ?? process.cwd(),
    ".tmp",
    "meditation-backtests",
    input.label,
  );
  return {
    rootDir,
    workspaceDir: path.join(rootDir, "workspace"),
    logsDir: path.join(rootDir, "logs"),
    databasePath: path.join(rootDir, "pokoclaw.db"),
  };
}

export function buildMeditationBacktestSecurityConfig(
  input: BuildMeditationBacktestSecurityConfigInput,
): SecurityConfig {
  const sourceWorkspaceDir = path.resolve(input.sourceWorkspaceDir ?? POKOCLAW_WORKSPACE_DIR);
  const sourceLogsDir = path.resolve(input.sourceLogsDir ?? POKOCLAW_LOGS_DIR);
  const sourceDatabasePath = path.resolve(input.sourceDatabasePath ?? getProductionDatabasePath());
  const sourceDatabaseDir = path.dirname(sourceDatabasePath);
  const productionHomeDir = path.resolve(POKOCLAW_HOME_DIR);
  const hardDenyAdditions = dedupeStrings([
    ...buildDeniedTreePatterns(productionHomeDir),
    ...buildDeniedTreePatterns(sourceWorkspaceDir),
    ...buildDeniedTreePatterns(sourceLogsDir),
    sourceDatabasePath,
    ...buildDeniedTreePatterns(sourceDatabaseDir),
  ]);

  return {
    filesystem: {
      ...input.securityConfig.filesystem,
      hardDenyRead: dedupeStrings([
        ...input.securityConfig.filesystem.hardDenyRead,
        ...hardDenyAdditions,
      ]),
      hardDenyWrite: dedupeStrings([
        ...input.securityConfig.filesystem.hardDenyWrite,
        ...hardDenyAdditions,
      ]),
    },
    network: {
      ...input.securityConfig.network,
      hardDenyHosts: [...input.securityConfig.network.hardDenyHosts],
    },
  };
}

export async function prepareMeditationBacktestSandbox(input: {
  sandbox: MeditationBacktestSandboxPaths;
  sourceWorkspaceDir?: string;
  sourceDatabasePath?: string;
}): Promise<void> {
  await mkdir(input.sandbox.rootDir, { recursive: true });
  await mkdir(input.sandbox.workspaceDir, { recursive: true });
  await mkdir(input.sandbox.logsDir, { recursive: true });
  await mkdir(buildMeditationWorkspaceDir(input.sandbox.workspaceDir), { recursive: true });
  await mkdir(buildMeditationLogsRoot(input.sandbox.logsDir), { recursive: true });

  const sourceDatabasePath = input.sourceDatabasePath ?? getProductionDatabasePath();
  await copyFile(sourceDatabasePath, input.sandbox.databasePath);

  await seedMeditationBacktestWorkspace({
    sourceWorkspaceDir: input.sourceWorkspaceDir ?? POKOCLAW_WORKSPACE_DIR,
    targetWorkspaceDir: input.sandbox.workspaceDir,
  });
}

async function seedMeditationBacktestWorkspace(input: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): Promise<void> {
  const sharedMemorySource = buildWorkspaceSharedMemoryPath(input.sourceWorkspaceDir);
  const sharedMemoryTarget = buildWorkspaceSharedMemoryPath(input.targetWorkspaceDir);
  await mkdir(path.dirname(sharedMemoryTarget), { recursive: true });
  await copyIfExists(sharedMemorySource, sharedMemoryTarget);

  const sourceSubagentsDir = path.join(input.sourceWorkspaceDir, "subagents");
  const targetSubagentsDir = path.join(input.targetWorkspaceDir, "subagents");
  await mkdir(targetSubagentsDir, { recursive: true });

  let sourceSubagentEntries: string[];
  try {
    sourceSubagentEntries = await readdir(sourceSubagentsDir);
  } catch {
    sourceSubagentEntries = [];
  }

  for (const entry of sourceSubagentEntries) {
    const sourceSubagentDir = path.join(sourceSubagentsDir, entry);
    let sourceSubagentStat: Awaited<ReturnType<typeof stat>>;
    try {
      sourceSubagentStat = await stat(sourceSubagentDir);
    } catch {
      continue;
    }
    if (!sourceSubagentStat.isDirectory()) {
      continue;
    }

    const sourceMemory = path.join(sourceSubagentsDir, entry, "MEMORY.md");
    const targetMemory = path.join(targetSubagentsDir, entry, "MEMORY.md");
    await mkdir(path.dirname(targetMemory), { recursive: true });
    await copyIfExists(sourceMemory, targetMemory);
  }
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

export function sanitizeMeditationBacktestLabel(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildDeniedTreePatterns(rootPath: string): string[] {
  return [rootPath, `${rootPath}/**`];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
