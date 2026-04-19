/**
 * Narrow LLM executors for Meditation phases.
 *
 * This module intentionally does not use the full AgentLoop. It builds phase prompts,
 * runs a submit-only tool loop, and returns structured submissions plus debug trace.
 */
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { SecurityConfig } from "@/src/config/schema.js";
import type { PreparedMeditationBucket } from "@/src/meditation/bucket-prep.js";
import {
  type MeditationSubmitLoopResult,
  type MeditationTurnBridge,
  runMeditationSubmitLoop,
} from "@/src/meditation/llm-executor.js";
import {
  buildMeditationBucketSystemPrompt,
  buildMeditationBucketUserPrompt,
  buildMeditationConsolidationEvaluationSystemPrompt,
  buildMeditationConsolidationEvaluationUserPrompt,
  buildMeditationConsolidationRewriteSystemPrompt,
  buildMeditationConsolidationRewriteUserPrompt,
  type MeditationBucketPromptInput,
  type MeditationConsolidationEvaluationPromptInput,
  type MeditationConsolidationRewritePromptInput,
} from "@/src/meditation/prompts.js";
import {
  type BucketMeditationSubmit,
  type ConsolidationEvaluationSubmit,
  type ConsolidationRewriteSubmit,
  createBucketSubmitTool,
  createConsolidationEvaluationSubmitTool,
  createConsolidationRewriteSubmitTool,
} from "@/src/meditation/submit-tools.js";
import type { StorageDb } from "@/src/storage/db/client.js";

export const MAX_BUCKET_SUBMIT_TURNS = 2;
export const MAX_CONSOLIDATION_EVALUATION_SUBMIT_TURNS = 2;
export const MAX_CONSOLIDATION_REWRITE_SUBMIT_TURNS = 3;

export interface MeditationAgentExecution<TSubmission>
  extends MeditationSubmitLoopResult<TSubmission> {
  systemPrompt: string;
  prompt: string;
}

export interface RunMeditationBucketAgentInput extends MeditationBucketPromptInput {
  bridge: MeditationTurnBridge;
  model: ResolvedModel;
  storage: StorageDb;
  securityConfig: SecurityConfig;
  now?: () => Date;
}

export interface RunMeditationConsolidationEvaluationAgentInput {
  bridge: MeditationTurnBridge;
  model: ResolvedModel;
  promptInput: MeditationConsolidationEvaluationPromptInput;
  storage: StorageDb;
  securityConfig: SecurityConfig;
  now?: () => Date;
}

export interface RunMeditationConsolidationRewriteAgentInput {
  bridge: MeditationTurnBridge;
  model: ResolvedModel;
  promptInput: MeditationConsolidationRewritePromptInput;
  storage: StorageDb;
  securityConfig: SecurityConfig;
  now?: () => Date;
}

export async function runMeditationBucketAgent(
  input: RunMeditationBucketAgentInput,
): Promise<MeditationAgentExecution<BucketMeditationSubmit>> {
  const systemPrompt = buildMeditationBucketSystemPrompt();
  const prompt = buildMeditationBucketUserPrompt({
    currentDate: input.currentDate,
    timezone: input.timezone,
    meditationWindow: input.meditationWindow,
    bucket: input.bucket,
  });
  let submission: BucketMeditationSubmit | null = null;
  const result = await runMeditationSubmitLoop<BucketMeditationSubmit>({
    bridge: input.bridge,
    model: input.model,
    systemPrompt,
    prompt,
    storage: input.storage,
    securityConfig: input.securityConfig,
    tools: [
      createBucketSubmitTool((payload) => {
        submission = payload;
      }),
    ],
    getSubmission: () => submission,
    maxTurns: MAX_BUCKET_SUBMIT_TURNS,
    ...(input.now == null ? {} : { now: input.now }),
  });

  return {
    systemPrompt,
    prompt,
    ...result,
  };
}

export async function runMeditationConsolidationEvaluationAgent(
  input: RunMeditationConsolidationEvaluationAgentInput,
): Promise<MeditationAgentExecution<ConsolidationEvaluationSubmit>> {
  const systemPrompt = buildMeditationConsolidationEvaluationSystemPrompt();
  const prompt = buildMeditationConsolidationEvaluationUserPrompt(input.promptInput);
  let submission: ConsolidationEvaluationSubmit | null = null;
  const result = await runMeditationSubmitLoop<ConsolidationEvaluationSubmit>({
    bridge: input.bridge,
    model: input.model,
    systemPrompt,
    prompt,
    storage: input.storage,
    securityConfig: input.securityConfig,
    tools: [
      createConsolidationEvaluationSubmitTool((payload) => {
        submission = payload;
      }),
    ],
    getSubmission: () => submission,
    maxTurns: MAX_CONSOLIDATION_EVALUATION_SUBMIT_TURNS,
    ...(input.now == null ? {} : { now: input.now }),
  });

  return {
    systemPrompt,
    prompt,
    ...result,
  };
}

export async function runMeditationConsolidationRewriteAgent(
  input: RunMeditationConsolidationRewriteAgentInput,
): Promise<MeditationAgentExecution<ConsolidationRewriteSubmit>> {
  const systemPrompt = buildMeditationConsolidationRewriteSystemPrompt();
  const prompt = buildMeditationConsolidationRewriteUserPrompt(input.promptInput);
  let submission: ConsolidationRewriteSubmit | null = null;
  const result = await runMeditationSubmitLoop<ConsolidationRewriteSubmit>({
    bridge: input.bridge,
    model: input.model,
    systemPrompt,
    prompt,
    storage: input.storage,
    securityConfig: input.securityConfig,
    tools: [
      createConsolidationRewriteSubmitTool(
        (payload) => {
          submission = payload;
        },
        (payload) =>
          validateConsolidationRewriteSubmission({
            promptInput: input.promptInput,
            submission: payload,
          }),
      ),
    ],
    getSubmission: () => submission,
    maxTurns: MAX_CONSOLIDATION_REWRITE_SUBMIT_TURNS,
    ...(input.now == null ? {} : { now: input.now }),
  });

  return {
    systemPrompt,
    prompt,
    ...result,
  };
}

export type { PreparedMeditationBucket };

function validateConsolidationRewriteSubmission(input: {
  promptInput: MeditationConsolidationRewritePromptInput;
  submission: ConsolidationRewriteSubmit;
}): string[] {
  const issues: string[] = [];

  if (input.submission.shared_rewrite != null && input.submission.shared_rewrite !== "") {
    issues.push(
      ...validateRewriteMarkdownLength({
        targetLabel: "shared",
        currentMarkdown: input.promptInput.sharedMemoryCurrent,
        rewrittenMarkdown: input.submission.shared_rewrite.rewritten_markdown,
      }),
    );
  }

  const currentPrivateMemoryByAgentId = new Map(
    input.promptInput.bucketPackets.map(
      (packet) => [packet.agentId, packet.privateMemoryCurrent] as const,
    ),
  );
  for (const rewrite of input.submission.private_rewrites) {
    const currentMarkdown = currentPrivateMemoryByAgentId.get(rewrite.agent_id);
    if (typeof currentMarkdown !== "string") {
      continue;
    }
    issues.push(
      ...validateRewriteMarkdownLength({
        targetLabel: `private:${rewrite.agent_id}`,
        currentMarkdown,
        rewrittenMarkdown: rewrite.rewritten_markdown,
      }),
    );
  }

  return issues;
}

function validateRewriteMarkdownLength(input: {
  targetLabel: string;
  currentMarkdown: string;
  rewrittenMarkdown: string;
}): string[] {
  const currentLength = normalizeMarkdownForValidation(input.currentMarkdown).length;
  const rewrittenLength = normalizeMarkdownForValidation(input.rewrittenMarkdown).length;

  if (rewrittenLength === 0) {
    return [`${input.targetLabel} rewritten_markdown is empty.`];
  }

  if (currentLength === 0) {
    return [];
  }

  const minimumLength = Math.ceil(currentLength * 0.5);
  if (rewrittenLength < minimumLength) {
    return [
      `${input.targetLabel} rewritten_markdown is too short (${rewrittenLength} chars < ${minimumLength} minimum from current ${currentLength}). Preserve all existing semantics, including URLs, paths, constants, commands, and durable constraints.`,
    ];
  }

  return [];
}

function normalizeMarkdownForValidation(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").trim();
}
