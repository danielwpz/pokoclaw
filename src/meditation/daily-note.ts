/**
 * Daily meditation note renderer and appender.
 *
 * A single daily file is the durable human-readable artifact. Multiple runs on
 * the same day are appended as separate run blocks.
 */
import { readFile } from "node:fs/promises";

import {
  buildMeditationDailyNotePath,
  writeMeditationTextFileAtomic,
} from "@/src/meditation/files.js";
import type { MeditationFinding } from "@/src/meditation/submit-tools.js";

export interface MeditationDailyBucketBlock {
  bucketId: string;
  agentId: string | null;
  displayName: string | null;
  note: string;
  findings: MeditationFinding[];
}

export interface MeditationConsolidationSummary {
  sharedRewritten: boolean;
  privateRewrittenAgentIds: string[];
}

export interface BuildMeditationDailyRunBlockInput {
  runId: string;
  tickAt: string;
  localDate: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  bucketModelId: string;
  consolidationModelId: string;
  buckets: MeditationDailyBucketBlock[];
  consolidationSummary: MeditationConsolidationSummary;
}

export interface AppendMeditationDailyRunBlockInput {
  localDate: string;
  runBlock: string;
  workspaceDir?: string;
}

export function buildMeditationDailyRunBlock(input: BuildMeditationDailyRunBlockInput): string {
  const lines = [
    `# Meditation ${input.localDate}`,
    "",
    `## Run ${input.runId}`,
    `- Tick at: ${input.tickAt}`,
    `- Time zone: ${input.timezone}`,
    `- Window: ${input.windowStart} -> ${input.windowEnd}`,
    `- Bucket model: ${input.bucketModelId}`,
    `- Consolidation model: ${input.consolidationModelId}`,
    `- Buckets processed: ${input.buckets.length}`,
    "",
    "## Bucket Notes",
    ...(input.buckets.length === 0
      ? ["No active bucket produced a note in this run."]
      : input.buckets.flatMap((bucket) => renderBucketBlock(bucket))),
    "",
    "## Consolidation",
    `- Shared memory rewritten: ${input.consolidationSummary.sharedRewritten ? "yes" : "no"}`,
    "- Private memory rewrites:",
    ...(input.consolidationSummary.privateRewrittenAgentIds.length === 0
      ? ["  - (none)"]
      : input.consolidationSummary.privateRewrittenAgentIds.map((agentId) => `  - ${agentId}`)),
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function appendMeditationDailyRunBlock(
  input: AppendMeditationDailyRunBlockInput,
): Promise<void> {
  const filePath = buildMeditationDailyNotePath(input.localDate, input.workspaceDir);
  const previous = await readTextIfExists(filePath);
  const nextContent =
    previous.trim().length === 0
      ? input.runBlock.trimEnd()
      : `${previous.trimEnd()}\n\n---\n\n${input.runBlock.trimStart()}`.trimEnd();
  await writeMeditationTextFileAtomic(filePath, `${nextContent}\n`);
}

function renderBucketBlock(bucket: MeditationDailyBucketBlock): string[] {
  return [
    `### ${bucket.displayName ?? bucket.bucketId}`,
    `- Bucket id: ${bucket.bucketId}`,
    `- Owner agent id: ${bucket.agentId ?? "shared"}`,
    "",
    bucket.note.trim().length === 0 ? "(empty note)" : bucket.note.trimEnd(),
    "",
    "#### Findings",
    ...(bucket.findings.length === 0
      ? ["- (none)"]
      : bucket.findings.flatMap((finding) => [
          `- ${finding.summary}`,
          `  - issue_type: ${finding.issue_type}`,
          `  - scope_hint: ${finding.scope_hint}`,
          `  - cluster_ids: ${finding.cluster_ids.join(", ") || "(none)"}`,
          `  - evidence_summary: ${finding.evidence_summary}`,
        ])),
    "",
  ];
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
