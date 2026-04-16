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
import type {
  MeditationApprovedFinding,
  MeditationConsolidationRewritePromptInput,
} from "@/src/meditation/prompts.js";
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
  ConsolidationPrivateLessonsProposal,
  ConsolidationRewriteSubmit,
  ConsolidationRuleProposal,
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

interface MeditationRewriteProposalRejection {
  target: "shared" | "private";
  agentId?: string;
  reasons: string[];
}

interface EligiblePrivateLessonsRewrite {
  agentId: string;
  lessons: ConsolidationRuleProposal[];
}

const MAX_REPEAT_USE_LESSONS_PER_TARGET = 3;
const MAX_REPEAT_USE_RULE_TEXT_LENGTH = 240;
const REPEAT_USE_LESSONS_HEADING = "# Repeat-Use Lessons";

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
        rewriteRejections: [] as MeditationRewriteProposalRejection[],
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

          const rewriteDecision = materializeMeditationRewriteDecision({
            promptInput: consolidationRewritePromptInput,
            submission: consolidationRewrite.submission,
          });
          consolidationSummary = {
            ...consolidationSummary,
            rewriteRejections: rewriteDecision.rejections,
          };

          await writeJsonArtifact(
            path.join(artifactDir, "rewrite-rejections.json"),
            rewriteDecision.rejections,
          );

          for (const rejection of rewriteDecision.rejections) {
            logger.warn("meditation consolidation rejected rewrite proposal", {
              runId,
              target: rejection.target,
              agentId: rejection.agentId ?? null,
              reasons: rejection.reasons,
            });
          }

          if (rewriteDecision.sharedLessons != null) {
            const sharedPath = buildWorkspaceSharedMemoryPath(workspaceDir);
            const sharedMemoryRewrite = renderMemoryWithRepeatUseLessons({
              currentContent: consolidationRewritePromptInput.sharedMemoryCurrent,
              lessons: rewriteDecision.sharedLessons,
            });
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
          }

          for (const rewrite of rewriteDecision.privateLessons) {
            const privateWorkspaceDir = buildSubagentWorkspaceDir(
              rewrite.agentId,
              path.join(workspaceDir, "subagents"),
            );
            const packet = consolidationRewritePromptInput.bucketPackets.find(
              (candidate) => candidate.agentId === rewrite.agentId,
            );
            if (packet == null || packet.privateMemoryCurrent == null) {
              continue;
            }
            const privateMemoryRewrite = renderMemoryWithRepeatUseLessons({
              currentContent: packet.privateMemoryCurrent,
              lessons: rewrite.lessons,
            });
            await Promise.all([
              writeMeditationTextFileAtomic(
                path.join(artifactDir, "rewrite-preview", `private-${rewrite.agentId}.md`),
                privateMemoryRewrite,
              ),
              writeMeditationTextFileAtomic(
                buildPrivateWorkspaceMemoryPath(privateWorkspaceDir),
                privateMemoryRewrite,
              ),
            ]);
          }
          consolidationSummary = {
            ...consolidationSummary,
            privateRewrittenAgentIds: rewriteDecision.privateLessons.map(
              (rewrite) => rewrite.agentId,
            ),
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

function materializeMeditationRewriteDecision(input: {
  promptInput: MeditationConsolidationRewritePromptInput;
  submission: ConsolidationRewriteSubmit;
}): {
  sharedLessons: ConsolidationRuleProposal[] | null;
  privateLessons: EligiblePrivateLessonsRewrite[];
  rejections: MeditationRewriteProposalRejection[];
} {
  const sharedDecision = validateSharedLessonsProposal({
    approvedSharedFindings: input.promptInput.approvedSharedFindings,
    sharedRepeatUseLessons: input.submission.shared_repeat_use_lessons,
  });
  const privateDecision = validatePrivateLessonsProposals({
    bucketPackets: input.promptInput.bucketPackets,
    privateRepeatUseLessons: input.submission.private_repeat_use_lessons,
  });

  return {
    sharedLessons: sharedDecision.eligible,
    privateLessons: privateDecision.eligible,
    rejections: [...sharedDecision.rejections, ...privateDecision.rejections],
  };
}

function validateSharedLessonsProposal(input: {
  approvedSharedFindings: MeditationApprovedFinding[];
  sharedRepeatUseLessons: ConsolidationRuleProposal[] | null | "";
}): {
  eligible: ConsolidationRuleProposal[] | null;
  rejections: MeditationRewriteProposalRejection[];
} {
  if (input.sharedRepeatUseLessons == null || input.sharedRepeatUseLessons === "") {
    return {
      eligible: null,
      rejections: [],
    };
  }

  const reasons = summarizeRuleProposalIssues({
    lessons: input.sharedRepeatUseLessons,
    eligibleFindingIds: new Set(input.approvedSharedFindings.map((finding) => finding.findingId)),
    hasApprovedFindings: input.approvedSharedFindings.length > 0,
  });
  if (reasons.length > 0) {
    return {
      eligible: null,
      rejections: [
        {
          target: "shared",
          reasons,
        },
      ],
    };
  }

  return {
    eligible: normalizeRepeatUseLessonProposals(input.sharedRepeatUseLessons),
    rejections: [],
  };
}

function validatePrivateLessonsProposals(input: {
  bucketPackets: Array<{
    agentId: string;
    agentKind: "main" | "sub" | "shared" | "unknown";
    approvedPrivateFindings?: MeditationApprovedFinding[];
  }>;
  privateRepeatUseLessons: ConsolidationPrivateLessonsProposal[];
}): {
  eligible: EligiblePrivateLessonsRewrite[];
  rejections: MeditationRewriteProposalRejection[];
} {
  const packetByAgentId = new Map(
    input.bucketPackets.map((packet) => [packet.agentId, packet] as const),
  );
  const seenAgentIds = new Set<string>();
  const eligible: EligiblePrivateLessonsRewrite[] = [];
  const rejections: MeditationRewriteProposalRejection[] = [];

  for (const proposal of input.privateRepeatUseLessons) {
    const rejectionReasons = new Set<string>();
    const packet = packetByAgentId.get(proposal.agent_id);
    if (packet == null) {
      rejectionReasons.add("unknown_private_target");
    } else {
      if (seenAgentIds.has(proposal.agent_id)) {
        rejectionReasons.add("duplicate_private_target");
      }
      if (packet.agentKind !== "sub") {
        rejectionReasons.add("non_sub_private_target");
      }
      const proposalIssues = summarizeRuleProposalIssues({
        lessons: proposal.lessons,
        eligibleFindingIds: new Set(
          (packet.approvedPrivateFindings ?? []).map((finding) => finding.findingId),
        ),
        hasApprovedFindings: (packet.approvedPrivateFindings?.length ?? 0) > 0,
      });
      for (const issue of proposalIssues) {
        rejectionReasons.add(issue);
      }
    }

    if (rejectionReasons.size > 0) {
      rejections.push({
        target: "private",
        agentId: proposal.agent_id,
        reasons: [...rejectionReasons],
      });
      continue;
    }

    eligible.push({
      agentId: proposal.agent_id,
      lessons: normalizeRepeatUseLessonProposals(proposal.lessons),
    });
    seenAgentIds.add(proposal.agent_id);
  }

  return {
    eligible,
    rejections,
  };
}

function summarizeRuleProposalIssues(input: {
  lessons: ConsolidationRuleProposal[];
  eligibleFindingIds: Set<string>;
  hasApprovedFindings: boolean;
}): string[] {
  const issues = new Set<string>();

  if (!input.hasApprovedFindings) {
    issues.add("no_approved_findings");
  }
  if (input.lessons.length === 0) {
    issues.add("empty_lessons");
  }
  if (input.lessons.length > MAX_REPEAT_USE_LESSONS_PER_TARGET) {
    issues.add("too_many_lessons");
  }

  for (const lesson of input.lessons) {
    if (lesson.rule_text.trim().length === 0) {
      issues.add("empty_rule_text");
    }
    if (lesson.rule_text.includes("\n")) {
      issues.add("multiline_rule_text");
    }
    if (lesson.rule_text.trim().length > MAX_REPEAT_USE_RULE_TEXT_LENGTH) {
      issues.add("rule_too_long");
    }
    if (lesson.supported_finding_ids.length === 0) {
      issues.add("missing_supported_finding_ids");
    } else if (
      lesson.supported_finding_ids.some((findingId) => !input.eligibleFindingIds.has(findingId))
    ) {
      issues.add("unknown_supported_finding_id");
    }
    if (lesson.why_generalizable.trim().length === 0) {
      issues.add("missing_generalization_reason");
    }
    if (!lesson.evidence_examples.some((example) => example.trim().length > 0)) {
      issues.add("missing_evidence_examples");
    }
  }

  return [...issues];
}

function normalizeRepeatUseLessonProposals(
  lessons: ConsolidationRuleProposal[],
): ConsolidationRuleProposal[] {
  const seenRules = new Set<string>();
  const normalized: ConsolidationRuleProposal[] = [];

  for (const lesson of lessons) {
    const ruleText = lesson.rule_text.replace(/\s+/g, " ").trim();
    const key = ruleText.toLowerCase();
    if (ruleText.length === 0 || seenRules.has(key)) {
      continue;
    }
    seenRules.add(key);
    normalized.push({
      rule_text: ruleText,
      supported_finding_ids: [
        ...new Set(lesson.supported_finding_ids.map((id) => id.trim()).filter(Boolean)),
      ],
      why_generalizable: lesson.why_generalizable.replace(/\s+/g, " ").trim(),
      evidence_examples: [
        ...new Set(lesson.evidence_examples.map((example) => example.trim()).filter(Boolean)),
      ],
    });
  }

  return normalized;
}

function renderMemoryWithRepeatUseLessons(input: {
  currentContent: string;
  lessons: ConsolidationRuleProposal[];
}): string {
  const normalizedCurrent = input.currentContent.replace(/\r\n/g, "\n").trimEnd();
  const lessonLines =
    input.lessons.length === 0
      ? ""
      : input.lessons.map((lesson) => `- ${lesson.rule_text}`).join("\n");
  const replacementSection = [REPEAT_USE_LESSONS_HEADING, "", lessonLines].join("\n").trimEnd();
  const lines = normalizedCurrent.length === 0 ? [] : normalizedCurrent.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === REPEAT_USE_LESSONS_HEADING);

  if (headingIndex === -1) {
    const parts = [normalizedCurrent, replacementSection].filter((part) => part.trim().length > 0);
    return `${parts.join("\n\n").trimEnd()}\n`;
  }

  let nextHeadingIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("# ")) {
      nextHeadingIndex = index;
      break;
    }
  }

  const before = lines.slice(0, headingIndex).join("\n").trimEnd();
  const after = lines.slice(nextHeadingIndex).join("\n").trimStart();
  const parts = [before, replacementSection, after].filter((part) => part.trim().length > 0);
  return `${parts.join("\n\n").trimEnd()}\n`;
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
  privateMemoryRewrites: ConsolidationPrivateLessonsProposal[];
}): EligiblePrivateLessonsRewrite[] {
  return validatePrivateLessonsProposals({
    bucketPackets: input.bucketPackets,
    privateRepeatUseLessons: input.privateMemoryRewrites,
  }).eligible;
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
