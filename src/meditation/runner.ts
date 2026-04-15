/**
 * End-to-end Meditation pipeline orchestrator.
 *
 * Order:
 * 1) harvest + cluster
 * 2) per-bucket LLM synthesis
 * 3) consolidation evaluation
 * 4) consolidation rewrite
 * 5) artifact + daily note write
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import {
  type ProviderRegistrySource,
  resolveProviderRegistry,
} from "@/src/agent/llm/provider-registry-source.js";
import type { SecurityConfig, SelfHarnessConfig } from "@/src/config/schema.js";
import {
  runMeditationBucketAgent,
  runMeditationConsolidationEvaluationAgent,
  runMeditationConsolidationRewriteAgent,
} from "@/src/meditation/agent-runner.js";
import { prepareMeditationBucketInput } from "@/src/meditation/bucket-prep.js";
import { buildMeditationBuckets } from "@/src/meditation/clustering.js";
import {
  buildMeditationConsolidationRewritePromptInput,
  loadMeditationConsolidationEvaluationPromptInput,
} from "@/src/meditation/consolidation-context.js";
import {
  appendMeditationDailyRunBlock,
  buildMeditationDailyRunBlock,
} from "@/src/meditation/daily-note.js";
import {
  ensureMeditationRunArtifactDir,
  writeMeditationTextFileAtomic,
} from "@/src/meditation/files.js";
import type { MeditationTurnBridge } from "@/src/meditation/llm-executor.js";
import { maybeResolveMeditationModels, resolveMeditationModels } from "@/src/meditation/models.js";
import type { MeditationApprovedFinding } from "@/src/meditation/prompts.js";
import {
  type MeditationBucketProfile,
  type MeditationFailedToolResultFact,
  MeditationReadModel,
  type MeditationStopFact,
  type MeditationTaskFailureFact,
} from "@/src/meditation/read-model.js";
import type {
  MeditationRunner,
  MeditationRunRequest,
  MeditationRunResult,
} from "@/src/meditation/scheduler.js";
import type {
  ConsolidationMemoryRewrite,
  MeditationFinding,
} from "@/src/meditation/submit-tools.js";
import { resolveMeditationWindow } from "@/src/meditation/window.js";
import {
  buildPrivateWorkspaceMemoryPath,
  buildWorkspaceSharedMemoryPath,
} from "@/src/memory/files.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { buildSubagentWorkspaceDir, POKOCLAW_WORKSPACE_DIR } from "@/src/shared/paths.js";
import type { LocalCalendarContext } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import type { MeditationStateRepo } from "@/src/storage/repos/meditation-state.repo.js";

const MAX_BUCKETS_PER_RUN = 4;
const logger = createSubsystemLogger("meditation/runner");

interface MeditationPipelineRunnerDependencies {
  storage: StorageDb;
  state: MeditationStateRepo;
  config: SelfHarnessConfig;
  models: ProviderRegistry | ProviderRegistrySource;
  bridge: MeditationTurnBridge;
  securityConfig: SecurityConfig;
  workspaceDir?: string;
  logsDir?: string;
  createRunId?: () => string;
  resolveCalendarContext?: (tickAt: Date) => LocalCalendarContext;
}

interface MeditationHarvestArtifact {
  stops: MeditationStopFact[];
  taskFailures: MeditationTaskFailureFact[];
  failedToolResults: MeditationFailedToolResultFact[];
}

interface MeditationBucketArtifact {
  bucketId: string;
  agentId: string | null;
  score: number;
  preferredSessionIds: string[];
  profile: MeditationBucketProfile | null;
  clusters: unknown[];
}

interface CompletedMeditationBucket {
  bucketId: string;
  agentId: string | null;
  profile: MeditationBucketProfile | null;
  note: string;
  findings: MeditationFinding[];
}

export class MeditationPipelineRunner implements MeditationRunner {
  private readonly readModel: MeditationReadModel;

  constructor(private readonly deps: MeditationPipelineRunnerDependencies) {
    this.readModel = new MeditationReadModel(deps.storage);
  }

  async runOnce(input: MeditationRunRequest): Promise<MeditationRunResult> {
    const state = this.deps.state.getOrCreateDefault(input.tickAt);
    const calendarContext = this.deps.resolveCalendarContext?.(input.tickAt);
    const window =
      input.windowOverride ??
      resolveMeditationWindow({
        tickAt: input.tickAt,
        lastSuccessAt: state.lastSuccessAt,
        ...(calendarContext == null ? {} : { calendarContext }),
      });
    const runId = this.deps.createRunId?.() ?? randomUUID();
    const artifactDir = await ensureMeditationRunArtifactDir(
      window.localDate,
      runId,
      this.deps.logsDir,
    );

    const harvest: MeditationHarvestArtifact = {
      stops: this.readModel.listStopFacts(window.startAt, window.endAt),
      taskFailures: this.readModel.listTaskFailureFacts(window.startAt, window.endAt),
      failedToolResults: this.readModel.listFailedToolResults(window.startAt, window.endAt),
    };
    const clusteredBuckets = buildMeditationBuckets(harvest);
    const bucketArtifacts: MeditationBucketArtifact[] = clusteredBuckets.map((bucket) => ({
      bucketId: bucket.bucketId,
      agentId: bucket.agentId,
      score: bucket.score,
      preferredSessionIds: bucket.preferredSessionIds,
      profile:
        bucket.agentId == null
          ? null
          : this.readModel.resolveBucketProfile(bucket.agentId, bucket.preferredSessionIds),
      clusters: bucket.clusters,
    }));
    const bucketInputs = clusteredBuckets.map((bucket) =>
      prepareMeditationBucketInput({
        bucket,
        readModel: this.readModel,
      }),
    );
    const registry = resolveProviderRegistry(this.deps.models);
    const configuredModels = maybeResolveMeditationModels({
      registry,
    });
    const executedBucketInputs =
      configuredModels == null ? [] : bucketInputs.slice(0, MAX_BUCKETS_PER_RUN);
    const workspaceDir = this.deps.workspaceDir ?? POKOCLAW_WORKSPACE_DIR;
    const startedAtMs = Date.now();

    try {
      const meta = {
        runId,
        tickAt: input.tickAt.toISOString(),
        localDate: window.localDate,
        timezone: window.timezone,
        window,
        models: {
          bucketModelId: configuredModels?.bucket.id ?? null,
          consolidationModelId: configuredModels?.consolidation.id ?? null,
        },
        counts: {
          stops: harvest.stops.length,
          taskFailures: harvest.taskFailures.length,
          failedToolResults: harvest.failedToolResults.length,
          buckets: bucketArtifacts.length,
          executedBuckets: executedBucketInputs.length,
        },
      };

      const writes: Promise<void>[] = [
        writeJsonArtifact(path.join(artifactDir, "meta.json"), meta),
        writeJsonArtifact(path.join(artifactDir, "harvest.json"), harvest),
        writeJsonArtifact(path.join(artifactDir, "clusters.json"), clusteredBuckets),
        writeJsonArtifact(path.join(artifactDir, "buckets.json"), bucketArtifacts),
        writeJsonArtifact(path.join(artifactDir, "bucket-inputs.json"), bucketInputs),
      ];
      await Promise.all(writes);

      if (configuredModels == null) {
        logger.warn("meditation run skipped because no meditation models are configured", {
          runId,
          tickAt: input.tickAt.toISOString(),
        });
        return {
          skipped: true,
          reason: "no_models",
          bucketsExecuted: 0,
        };
      }

      if (executedBucketInputs.length === 0) {
        return {
          skipped: true,
          reason: "no_buckets",
          bucketsExecuted: 0,
        };
      }

      const resolvedModels = resolveMeditationModels({
        registry,
      });

      logger.info("meditation pipeline run started", {
        runId,
        tickAt: input.tickAt.toISOString(),
        localDate: window.localDate,
        timezone: window.timezone,
        artifactDir,
        windowStart: window.startAt,
        windowEnd: window.endAt,
        bucketModelId: resolvedModels.bucket.id,
        consolidationModelId: resolvedModels.consolidation.id,
      });
      logger.info("meditation harvest complete", {
        runId,
        stops: harvest.stops.length,
        taskFailures: harvest.taskFailures.length,
        failedToolResults: harvest.failedToolResults.length,
        bucketsFound: bucketArtifacts.length,
        bucketsScheduled: executedBucketInputs.length,
      });

      const completedBuckets: CompletedMeditationBucket[] = [];
      for (const bucketInput of executedBucketInputs) {
        logger.info("meditation bucket started", {
          runId,
          bucketId: bucketInput.bucketId,
          agentId: bucketInput.agentId ?? "shared",
          score: bucketInput.score,
          clusterCount: bucketInput.clusters.length,
          displayName: bucketInput.profile?.displayName ?? null,
        });
        const execution = await runMeditationBucketAgent({
          bridge: this.deps.bridge,
          model: resolvedModels.bucket,
          storage: this.deps.storage,
          securityConfig: this.deps.securityConfig,
          currentDate: window.localDate,
          timezone: window.timezone,
          meditationWindow: window,
          bucket: bucketInput,
        });
        completedBuckets.push({
          bucketId: bucketInput.bucketId,
          agentId: bucketInput.agentId,
          profile: bucketInput.profile,
          note: execution.submission.note,
          findings: execution.submission.findings,
        });
        logger.info("meditation bucket completed", {
          runId,
          bucketId: bucketInput.bucketId,
          agentId: bucketInput.agentId ?? "shared",
          findings: execution.submission.findings.length,
          turnCount: execution.turns.length,
        });
        await Promise.all([
          writeMeditationTextFileAtomic(
            path.join(artifactDir, `bucket-${bucketInput.bucketId}.prompt.md`),
            formatPromptArtifact({
              systemPrompt: execution.systemPrompt,
              userPrompt: execution.prompt,
            }),
          ),
          writeJsonArtifact(
            path.join(artifactDir, `bucket-${bucketInput.bucketId}.submit.json`),
            execution.submission,
          ),
          writeJsonArtifact(
            path.join(artifactDir, `bucket-${bucketInput.bucketId}.turns.json`),
            execution.turns,
          ),
          writeJsonArtifact(
            path.join(artifactDir, `bucket-${bucketInput.bucketId}.messages.json`),
            execution.messages,
          ),
        ]);
      }

      let consolidationSummary = {
        sharedRewritten: false,
        privateRewrittenAgentIds: [] as string[],
      };
      if (completedBuckets.length > 0) {
        logger.info("meditation consolidation evaluation started", {
          runId,
          bucketCount: completedBuckets.length,
          findingCount: completedBuckets.reduce((sum, bucket) => sum + bucket.findings.length, 0),
        });
        const consolidationEvaluationPromptInput =
          await loadMeditationConsolidationEvaluationPromptInput({
            currentDate: window.localDate,
            currentRunId: runId,
            timezone: window.timezone,
            workspaceDir,
            ...(this.deps.logsDir == null ? {} : { logsDir: this.deps.logsDir }),
            buckets: completedBuckets,
          });
        const consolidationEvaluation = await runMeditationConsolidationEvaluationAgent({
          bridge: this.deps.bridge,
          model: resolvedModels.consolidation,
          storage: this.deps.storage,
          securityConfig: this.deps.securityConfig,
          promptInput: consolidationEvaluationPromptInput,
        });
        await Promise.all([
          writeMeditationTextFileAtomic(
            path.join(artifactDir, "consolidation-eval.prompt.md"),
            formatPromptArtifact({
              systemPrompt: consolidationEvaluation.systemPrompt,
              userPrompt: consolidationEvaluation.prompt,
            }),
          ),
          writeJsonArtifact(
            path.join(artifactDir, "consolidation-eval.submit.json"),
            consolidationEvaluation.submission,
          ),
        ]);

        logger.info("meditation consolidation evaluation completed", {
          runId,
          evaluationCount: consolidationEvaluation.submission.evaluations.length,
          turnCount: consolidationEvaluation.turns.length,
        });

        const consolidationRewritePromptInput = buildMeditationConsolidationRewritePromptInput({
          evaluationPromptInput: consolidationEvaluationPromptInput,
          evaluation: consolidationEvaluation.submission,
        });
        if (hasApprovedFindings(consolidationRewritePromptInput)) {
          logger.info("meditation consolidation rewrite started", {
            runId,
            bucketCount: consolidationRewritePromptInput.bucketPackets.length,
            approvedFindingCount: countApprovedFindings(consolidationRewritePromptInput),
          });
          const consolidationRewrite = await runMeditationConsolidationRewriteAgent({
            bridge: this.deps.bridge,
            model: resolvedModels.consolidation,
            storage: this.deps.storage,
            securityConfig: this.deps.securityConfig,
            promptInput: consolidationRewritePromptInput,
          });
          await Promise.all([
            writeMeditationTextFileAtomic(
              path.join(artifactDir, "consolidation-rewrite.prompt.md"),
              formatPromptArtifact({
                systemPrompt: consolidationRewrite.systemPrompt,
                userPrompt: consolidationRewrite.prompt,
              }),
            ),
            writeJsonArtifact(
              path.join(artifactDir, "consolidation-rewrite.submit.json"),
              consolidationRewrite.submission,
            ),
          ]);

          const sharedMemoryRewrite = normalizeNonEmptyMeditationRewrite(
            consolidationRewrite.submission.shared_memory_rewrite,
          );
          if (
            sharedMemoryRewrite != null &&
            isMeditationRewriteQualityAcceptable(sharedMemoryRewrite) &&
            consolidationRewritePromptInput.approvedSharedFindings.length > 0
          ) {
            const sharedPath = buildWorkspaceSharedMemoryPath(workspaceDir);
            await Promise.all([
              writeMeditationTextFileAtomic(
                path.join(artifactDir, "rewrite-preview", "shared.md"),
                sharedMemoryRewrite,
              ),
              writeMeditationTextFileAtomic(sharedPath, sharedMemoryRewrite),
            ]);
            consolidationSummary = {
              ...consolidationSummary,
              sharedRewritten: true,
            };
          } else if (
            sharedMemoryRewrite != null &&
            consolidationRewritePromptInput.approvedSharedFindings.length === 0
          ) {
            logger.warn("meditation consolidation dropped ineligible shared rewrite", {
              runId,
            });
          } else if (
            sharedMemoryRewrite != null &&
            !isMeditationRewriteQualityAcceptable(sharedMemoryRewrite)
          ) {
            logger.warn("meditation consolidation dropped low-quality shared rewrite", {
              runId,
              issues: summarizeMeditationRewriteQualityIssues(sharedMemoryRewrite),
            });
          }

          const eligiblePrivateRewrites = filterEligiblePrivateMemoryRewrites({
            bucketPackets: consolidationRewritePromptInput.bucketPackets,
            privateMemoryRewrites: consolidationRewrite.submission.private_memory_rewrites,
          });
          const droppedPrivateRewriteAgentIds =
            consolidationRewrite.submission.private_memory_rewrites
              .map((rewrite) => rewrite.agent_id)
              .filter(
                (agentId) =>
                  !eligiblePrivateRewrites.some((rewrite) => rewrite.agent_id === agentId),
              );
          if (droppedPrivateRewriteAgentIds.length > 0) {
            logger.warn("meditation consolidation dropped ineligible private rewrites", {
              runId,
              droppedPrivateRewriteAgentIds,
            });
          }

          for (const rewrite of eligiblePrivateRewrites) {
            const privateWorkspaceDir = buildSubagentWorkspaceDir(
              rewrite.agent_id,
              path.join(workspaceDir, "subagents"),
            );
            await Promise.all([
              writeMeditationTextFileAtomic(
                path.join(artifactDir, "rewrite-preview", `private-${rewrite.agent_id}.md`),
                rewrite.content,
              ),
              writeMeditationTextFileAtomic(
                buildPrivateWorkspaceMemoryPath(privateWorkspaceDir),
                rewrite.content,
              ),
            ]);
          }
          consolidationSummary = {
            ...consolidationSummary,
            privateRewrittenAgentIds: eligiblePrivateRewrites.map((rewrite) => rewrite.agent_id),
          };
          logger.info("meditation consolidation rewrite completed", {
            runId,
            sharedRewritten: consolidationSummary.sharedRewritten,
            privateRewriteCount: consolidationSummary.privateRewrittenAgentIds.length,
            privateRewriteAgentIds: consolidationSummary.privateRewrittenAgentIds,
            turnCount: consolidationRewrite.turns.length,
          });
        } else {
          logger.info("meditation consolidation rewrite skipped because nothing was approved", {
            runId,
          });
        }
      } else {
        logger.info("meditation consolidation skipped because no bucket produced output", {
          runId,
        });
      }

      const dailyRunBlock = buildMeditationDailyRunBlock({
        runId,
        tickAt: input.tickAt.toISOString(),
        localDate: window.localDate,
        timezone: window.timezone,
        windowStart: window.startAt,
        windowEnd: window.endAt,
        bucketModelId: resolvedModels.bucket.id,
        consolidationModelId: resolvedModels.consolidation.id,
        buckets: completedBuckets.map((bucket) => ({
          bucketId: bucket.bucketId,
          agentId: bucket.agentId,
          displayName: bucket.profile?.displayName ?? null,
          note: bucket.note,
          findings: bucket.findings,
        })),
        consolidationSummary,
      });
      await writeMeditationTextFileAtomic(path.join(artifactDir, "daily-note.md"), dailyRunBlock);
      await appendMeditationDailyRunBlock({
        localDate: window.localDate,
        workspaceDir,
        runBlock: dailyRunBlock,
      });

      logger.info("meditation daily note updated", {
        runId,
        localDate: window.localDate,
        workspaceDir,
      });
      logger.info("meditation pipeline run completed", {
        runId,
        localDate: window.localDate,
        durationMs: Date.now() - startedAtMs,
        bucketsExecuted: completedBuckets.length,
        sharedRewritten: consolidationSummary.sharedRewritten,
        privateRewriteCount: consolidationSummary.privateRewrittenAgentIds.length,
      });
      return {
        skipped: false,
        bucketsExecuted: completedBuckets.length,
      };
    } catch (error) {
      logger.error("meditation pipeline run failed", {
        runId,
        localDate: window.localDate,
        artifactDir,
        durationMs: Date.now() - startedAtMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function normalizeNonEmptyMeditationRewrite(content: string | null): string | null {
  if (content == null) {
    return null;
  }

  return content.trim().length === 0 ? null : content;
}

async function writeJsonArtifact(filePath: string, payload: unknown): Promise<void> {
  await writeMeditationTextFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function filterEligiblePrivateMemoryRewrites(input: {
  bucketPackets: Array<{
    agentId: string;
    agentKind: "main" | "sub" | "shared" | "unknown";
    approvedPrivateFindings?: MeditationApprovedFinding[];
  }>;
  privateMemoryRewrites: ConsolidationMemoryRewrite[];
}): ConsolidationMemoryRewrite[] {
  const eligibleAgentIds = new Set(
    input.bucketPackets
      .filter(
        (packet) => packet.agentKind === "sub" && (packet.approvedPrivateFindings?.length ?? 0) > 0,
      )
      .map((packet) => packet.agentId),
  );

  return input.privateMemoryRewrites.filter(
    (rewrite) =>
      eligibleAgentIds.has(rewrite.agent_id) &&
      isMeditationRewriteQualityAcceptable(rewrite.content),
  );
}

function hasApprovedFindings(input: {
  approvedSharedFindings: MeditationApprovedFinding[];
  bucketPackets: Array<{ approvedPrivateFindings: MeditationApprovedFinding[] }>;
}): boolean {
  return (
    input.approvedSharedFindings.length > 0 ||
    input.bucketPackets.some((packet) => packet.approvedPrivateFindings.length > 0)
  );
}

function countApprovedFindings(input: {
  approvedSharedFindings: MeditationApprovedFinding[];
  bucketPackets: Array<{ approvedPrivateFindings: MeditationApprovedFinding[] }>;
}): number {
  return (
    input.approvedSharedFindings.length +
    input.bucketPackets.reduce((sum, packet) => sum + packet.approvedPrivateFindings.length, 0)
  );
}

function formatPromptArtifact(input: { systemPrompt: string; userPrompt: string }): string {
  return [
    "# System Prompt",
    "",
    input.systemPrompt.trimEnd(),
    "",
    "# User Prompt",
    "",
    input.userPrompt.trimEnd(),
    "",
  ].join("\n");
}

const MEDITATION_REWRITE_QUALITY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "timestamp",
    pattern: /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/,
  },
  {
    name: "session_reference",
    pattern: /\bacross sessions?\b/i,
  },
  {
    name: "occurrence_count",
    pattern: /\b\d+\s+occurrences?\b/i,
  },
  {
    name: "incident_count",
    pattern: /\b\d+\s+(?:times|repeats?)\b/i,
  },
  {
    name: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
  {
    name: "incident_narration",
    pattern: /\b(this affects|the task was blocked because|occurred between|occurred at)\b/i,
  },
];

export function summarizeMeditationRewriteQualityIssues(content: string): string[] {
  return MEDITATION_REWRITE_QUALITY_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ name }) => name,
  );
}

export function isMeditationRewriteQualityAcceptable(content: string): boolean {
  return summarizeMeditationRewriteQualityIssues(content).length === 0;
}
