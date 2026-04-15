/**
 * Host-side context loaders for Meditation consolidation.
 *
 * Evaluation sees current bucket findings, same-agent recent history, and
 * current shared/private memory files. Rewrite sees only approved findings plus
 * current memory files.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { buildMeditationLogsRoot } from "@/src/meditation/files.js";
import {
  type MeditationApprovedFinding,
  type MeditationBucketHistoryStats,
  type MeditationConsolidationBucketPacket,
  type MeditationConsolidationEvaluationPromptInput,
  type MeditationConsolidationRewritePromptInput,
  toMeditationBucketFindingContext,
} from "@/src/meditation/prompts.js";
import type { MeditationBucketProfile } from "@/src/meditation/read-model.js";
import type {
  ConsolidationEvaluationSubmit,
  MeditationFinding,
} from "@/src/meditation/submit-tools.js";
import {
  buildPrivateWorkspaceMemoryPath,
  buildWorkspaceSharedMemoryPath,
  ensureAgentMemoryFiles,
} from "@/src/memory/files.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  buildSubagentWorkspaceDir,
  POKOCLAW_LOGS_DIR,
  POKOCLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";

const DEFAULT_HISTORY_LOOKBACK_DAYS = 7;
const MAX_HISTORY_FINDINGS_PER_AGENT = 5;
const RUN_DIR_PATTERN = /^(\d{4}-\d{2}-\d{2})--(.+)$/;
const logger = createSubsystemLogger("meditation/consolidation-context");

export interface MeditationConsolidationBucketResult {
  bucketId: string;
  agentId: string | null;
  profile: MeditationBucketProfile | null;
  note: string;
  findings: MeditationFinding[];
}

export interface LoadMeditationConsolidationEvaluationPromptInputInput {
  currentDate: string;
  currentRunId: string;
  timezone: string;
  workspaceDir?: string;
  logsDir?: string;
  buckets: MeditationConsolidationBucketResult[];
  historyLookbackDays?: number;
}

export async function loadMeditationConsolidationEvaluationPromptInput(
  input: LoadMeditationConsolidationEvaluationPromptInputInput,
): Promise<MeditationConsolidationEvaluationPromptInput> {
  const workspaceDir = input.workspaceDir ?? POKOCLAW_WORKSPACE_DIR;
  ensureAgentMemoryFiles({
    agentKind: "main",
    workspaceDir,
  });

  const sharedMemoryCurrent = await readFile(buildWorkspaceSharedMemoryPath(workspaceDir), "utf8");
  const recentHistoryByAgentId = await loadRecentFindingHistory({
    currentDate: input.currentDate,
    currentRunId: input.currentRunId,
    logsDir: input.logsDir ?? POKOCLAW_LOGS_DIR,
    targetAgentIds: input.buckets
      .map((bucket) => bucket.agentId)
      .filter((agentId): agentId is string => agentId != null),
    lookbackDays: input.historyLookbackDays ?? DEFAULT_HISTORY_LOOKBACK_DAYS,
  });

  const bucketPackets = await loadBucketPackets({
    workspaceDir,
    buckets: input.buckets,
    recentHistoryByAgentId,
  });

  return {
    currentDate: input.currentDate,
    timezone: input.timezone,
    sharedMemoryCurrent,
    bucketPackets,
  };
}

export function buildMeditationConsolidationRewritePromptInput(input: {
  evaluationPromptInput: MeditationConsolidationEvaluationPromptInput;
  evaluation: ConsolidationEvaluationSubmit;
}): MeditationConsolidationRewritePromptInput {
  type RewriteBucketPacket = MeditationConsolidationRewritePromptInput["bucketPackets"][number];
  const evaluationByFindingId = new Map(
    input.evaluation.evaluations.map((evaluation) => [evaluation.finding_id, evaluation] as const),
  );

  const bucketPackets = input.evaluationPromptInput.bucketPackets
    .map((packet) => {
      const approvedFindings: MeditationApprovedFinding[] = packet.currentFindings.flatMap(
        (finding) => {
          const evaluation = evaluationByFindingId.get(finding.findingId);
          if (evaluation == null || evaluation.promotion_decision === "keep_in_meditation") {
            return [];
          }
          if (evaluation.promotion_decision === "private_memory" && packet.agentKind !== "sub") {
            return [];
          }

          return [
            {
              findingId: finding.findingId,
              agentId: packet.agentId,
              agentKind: packet.agentKind,
              priority: evaluation.priority,
              durability: evaluation.durability,
              promotionDecision: evaluation.promotion_decision,
              reason: evaluation.reason,
              summary: finding.summary,
              issueType: finding.issueType,
              scopeHint: finding.scopeHint,
              evidenceSummary: finding.evidenceSummary,
            },
          ];
        },
      );

      return approvedFindings.length === 0
        ? null
        : {
            bucketId: packet.bucketId,
            agentId: packet.agentId,
            agentKind: packet.agentKind,
            displayName: packet.displayName,
            description: packet.description,
            workdir: packet.workdir,
            compactSummary: packet.compactSummary,
            privateMemoryCurrent: packet.privateMemoryCurrent,
            approvedFindings,
          };
    })
    .filter((packet): packet is RewriteBucketPacket => packet != null);

  return {
    currentDate: input.evaluationPromptInput.currentDate,
    timezone: input.evaluationPromptInput.timezone,
    sharedMemoryCurrent: input.evaluationPromptInput.sharedMemoryCurrent,
    bucketPackets,
  };
}

async function loadBucketPackets(input: {
  workspaceDir: string;
  buckets: MeditationConsolidationBucketResult[];
  recentHistoryByAgentId: Map<
    string,
    {
      history: MeditationConsolidationBucketPacket["recentHistory"];
      stats: MeditationBucketHistoryStats;
    }
  >;
}): Promise<MeditationConsolidationEvaluationPromptInput["bucketPackets"]> {
  const packets: MeditationConsolidationEvaluationPromptInput["bucketPackets"] = [];
  for (const bucket of input.buckets) {
    if (bucket.agentId == null || bucket.profile == null) {
      continue;
    }

    const agentKind: MeditationConsolidationEvaluationPromptInput["bucketPackets"][number]["agentKind"] =
      bucket.profile.kind === "main" ? "main" : "sub";
    const privateMemoryCurrent =
      agentKind === "sub"
        ? await loadPrivateMemoryCurrent({
            workspaceDir: input.workspaceDir,
            agentId: bucket.agentId,
          })
        : null;
    const recentHistory = input.recentHistoryByAgentId.get(bucket.agentId);
    packets.push({
      bucketId: bucket.bucketId,
      agentId: bucket.agentId,
      agentKind,
      displayName: bucket.profile.displayName,
      description: bucket.profile.description,
      workdir: bucket.profile.workdir,
      compactSummary: bucket.profile.compactSummary,
      privateMemoryCurrent,
      bucketNote: bucket.note,
      currentFindings: toMeditationBucketFindingContext(bucket.bucketId, bucket.findings),
      recentHistory: recentHistory?.history ?? [],
      recentHistoryStats: recentHistory?.stats ?? {
        daysWithFindings: 0,
        totalFindings: 0,
        countsByIssueType: {},
      },
    });
  }

  return packets;
}

async function loadRecentFindingHistory(input: {
  currentDate: string;
  currentRunId: string;
  logsDir: string;
  targetAgentIds: string[];
  lookbackDays: number;
}): Promise<
  Map<
    string,
    {
      history: MeditationConsolidationBucketPacket["recentHistory"];
      stats: MeditationBucketHistoryStats;
    }
  >
> {
  const targetAgentIds = new Set(input.targetAgentIds);
  if (targetAgentIds.size === 0) {
    return new Map();
  }

  const logsRoot = buildMeditationLogsRoot(input.logsDir);
  let entries: string[];
  try {
    entries = await readdir(logsRoot);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }

  const currentMs = Date.parse(`${input.currentDate}T00:00:00.000Z`);
  const minMs = currentMs - (input.lookbackDays - 1) * 24 * 60 * 60 * 1_000;
  const historyByAgentId = new Map<
    string,
    {
      history: MeditationConsolidationBucketPacket["recentHistory"];
      stats: {
        dates: Set<string>;
        totalFindings: number;
        countsByIssueType: MeditationBucketHistoryStats["countsByIssueType"];
      };
    }
  >();

  for (const entry of entries.sort().reverse()) {
    const match = RUN_DIR_PATTERN.exec(entry);
    if (match == null) {
      continue;
    }
    const date = match[1];
    const runId = match[2];
    if (date == null || runId == null) {
      continue;
    }
    const dateMs = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isNaN(dateMs) || dateMs < minMs || dateMs > currentMs) {
      continue;
    }
    if (date === input.currentDate && runId === input.currentRunId) {
      continue;
    }

    const runDir = path.join(logsRoot, entry);
    const bucketInputs = await readJsonIfExists<
      Array<{ bucketId?: string; agentId?: string | null }>
    >(path.join(runDir, "bucket-inputs.json"));
    if (bucketInputs == null) {
      continue;
    }

    for (const bucketInput of bucketInputs) {
      if (
        bucketInput.bucketId == null ||
        bucketInput.agentId == null ||
        !targetAgentIds.has(bucketInput.agentId)
      ) {
        continue;
      }

      const submission = await readJsonIfExists<{ findings?: MeditationFinding[] }>(
        path.join(runDir, `bucket-${bucketInput.bucketId}.submit.json`),
      );
      if (submission?.findings == null) {
        continue;
      }

      const existing = historyByAgentId.get(bucketInput.agentId) ?? {
        history: [],
        stats: {
          dates: new Set<string>(),
          totalFindings: 0,
          countsByIssueType: {},
        },
      };

      for (const finding of submission.findings) {
        existing.stats.totalFindings += 1;
        existing.stats.dates.add(date);
        existing.stats.countsByIssueType[finding.issue_type] =
          (existing.stats.countsByIssueType[finding.issue_type] ?? 0) + 1;
        if (existing.history.length < MAX_HISTORY_FINDINGS_PER_AGENT) {
          existing.history.push({
            date,
            runId,
            summary: finding.summary,
            issueType: finding.issue_type,
            scopeHint: finding.scope_hint,
            evidenceSummary: finding.evidence_summary,
          });
        }
      }

      historyByAgentId.set(bucketInput.agentId, existing);
    }
  }

  return new Map(
    [...historyByAgentId.entries()].map(([agentId, value]) => [
      agentId,
      {
        history: value.history,
        stats: {
          daysWithFindings: value.stats.dates.size,
          totalFindings: value.stats.totalFindings,
          countsByIssueType: value.stats.countsByIssueType,
        },
      },
    ]),
  );
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

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    logger.warn("failed to read meditation consolidation history artifact", {
      filePath,
      error: nodeError.message,
    });
    return null;
  }
}
