/**
 * Host-side context loader for Consolidation.
 *
 * It prepares only the data needed for one consolidation run:
 * shared memory, touched SubAgent private memories, bucket outputs, and recent
 * meditation excerpts (bounded lookback).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildMeditationWorkspaceDir } from "@/src/meditation/files.js";
import type { MeditationConsolidationPromptInput } from "@/src/meditation/prompts.js";
import type { MeditationBucketProfile } from "@/src/meditation/read-model.js";
import {
  buildPrivateWorkspaceMemoryPath,
  buildWorkspaceSharedMemoryPath,
  ensureAgentMemoryFiles,
} from "@/src/memory/files.js";
import { buildSubagentWorkspaceDir, POKECLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";

const DEFAULT_EXCERPT_LOOKBACK_DAYS = 7;
const MAX_EXCERPT_CHARS = 2_000;

export interface MeditationConsolidationBucketResult {
  agentId: string | null;
  profile: MeditationBucketProfile | null;
  note: string;
  memoryCandidates: string[];
}

export interface LoadMeditationConsolidationPromptInputInput {
  currentDate: string;
  timezone: string;
  workspaceDir?: string;
  buckets: MeditationConsolidationBucketResult[];
  excerptLookbackDays?: number;
}

export async function loadMeditationConsolidationPromptInput(
  input: LoadMeditationConsolidationPromptInputInput,
): Promise<MeditationConsolidationPromptInput> {
  const workspaceDir = input.workspaceDir ?? POKECLAW_WORKSPACE_DIR;
  ensureAgentMemoryFiles({
    agentKind: "main",
    workspaceDir,
  });

  const sharedMemoryCurrent = await readFile(buildWorkspaceSharedMemoryPath(workspaceDir), "utf8");
  const agentContexts = await loadAgentContexts({
    workspaceDir,
    buckets: input.buckets,
  });
  const recentMeditationExcerpts = await loadRecentMeditationExcerpts({
    currentDate: input.currentDate,
    workspaceDir,
    lookbackDays: input.excerptLookbackDays ?? DEFAULT_EXCERPT_LOOKBACK_DAYS,
  });

  return {
    currentDate: input.currentDate,
    timezone: input.timezone,
    sharedMemoryCurrent,
    agentContexts,
    recentMeditationExcerpts,
  };
}

async function loadAgentContexts(input: {
  workspaceDir: string;
  buckets: MeditationConsolidationBucketResult[];
}): Promise<MeditationConsolidationPromptInput["agentContexts"]> {
  const deduped = new Map<string, MeditationConsolidationBucketResult>();
  for (const bucket of input.buckets) {
    if (bucket.agentId == null) {
      continue;
    }
    deduped.set(bucket.agentId, bucket);
  }

  const agentContexts: MeditationConsolidationPromptInput["agentContexts"] = [];
  for (const [agentId, bucket] of deduped) {
    const isSubAgent = bucket.profile?.kind !== "main";
    const privateMemoryCurrent = isSubAgent
      ? await loadPrivateMemoryCurrent({
          workspaceDir: input.workspaceDir,
          agentId,
        })
      : null;
    agentContexts.push({
      agentId,
      agentKind: bucket.profile?.kind ?? "sub",
      displayName: bucket.profile?.displayName ?? null,
      description: bucket.profile?.description ?? null,
      workdir: bucket.profile?.workdir ?? null,
      compactSummary: bucket.profile?.compactSummary ?? null,
      privateMemoryCurrent,
      bucketNote: bucket.note,
      memoryCandidates: [...bucket.memoryCandidates],
    });
  }

  return agentContexts;
}

async function loadRecentMeditationExcerpts(input: {
  currentDate: string;
  workspaceDir: string;
  lookbackDays: number;
}): Promise<MeditationConsolidationPromptInput["recentMeditationExcerpts"]> {
  const meditationDir = buildMeditationWorkspaceDir(input.workspaceDir);
  let entries: string[];
  try {
    entries = await readdir(meditationDir);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const currentMs = Date.parse(`${input.currentDate}T00:00:00.000Z`);
  const minMs = currentMs - (input.lookbackDays - 1) * 24 * 60 * 60 * 1_000;
  const excerpts = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) => {
        const date = entry.slice(0, -3);
        const dateMs = Date.parse(`${date}T00:00:00.000Z`);
        if (Number.isNaN(dateMs) || dateMs < minMs || dateMs > currentMs) {
          return null;
        }

        const content = await readFile(path.join(meditationDir, entry), "utf8");
        const text = content.trim().slice(0, MAX_EXCERPT_CHARS);
        if (text.length === 0) {
          return null;
        }

        return {
          date,
          text,
        };
      }),
  );

  return excerpts
    .filter((entry): entry is NonNullable<(typeof excerpts)[number]> => entry != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadPrivateMemoryCurrent(input: {
  workspaceDir: string;
  agentId: string;
}): Promise<string> {
  const privateWorkspaceDir = buildSubagentWorkspaceDir(
    input.agentId,
    path.join(input.workspaceDir, "subagents"),
  );
  ensureAgentMemoryFiles({
    agentKind: "sub",
    workspaceDir: input.workspaceDir,
    privateWorkspaceDir,
  });
  return readFile(buildPrivateWorkspaceMemoryPath(privateWorkspaceDir), "utf8");
}
