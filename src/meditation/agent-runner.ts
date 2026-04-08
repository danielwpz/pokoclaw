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
  buildMeditationConsolidationSystemPrompt,
  buildMeditationConsolidationUserPrompt,
  type MeditationBucketPromptInput,
  type MeditationConsolidationPromptInput,
} from "@/src/meditation/prompts.js";
import {
  type BucketMeditationSubmit,
  type ConsolidationMeditationSubmit,
  createBucketSubmitTool,
  createConsolidationSubmitTool,
} from "@/src/meditation/submit-tools.js";
import type { StorageDb } from "@/src/storage/db/client.js";

export const MAX_BUCKET_SUBMIT_TURNS = 2;
export const MAX_CONSOLIDATION_SUBMIT_TURNS = 2;

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

export interface RunMeditationConsolidationAgentInput {
  bridge: MeditationTurnBridge;
  model: ResolvedModel;
  promptInput: MeditationConsolidationPromptInput;
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

export async function runMeditationConsolidationAgent(
  input: RunMeditationConsolidationAgentInput,
): Promise<MeditationAgentExecution<ConsolidationMeditationSubmit>> {
  const systemPrompt = buildMeditationConsolidationSystemPrompt();
  const prompt = buildMeditationConsolidationUserPrompt(input.promptInput);
  let submission: ConsolidationMeditationSubmit | null = null;
  const result = await runMeditationSubmitLoop<ConsolidationMeditationSubmit>({
    bridge: input.bridge,
    model: input.model,
    systemPrompt,
    prompt,
    storage: input.storage,
    securityConfig: input.securityConfig,
    tools: [
      createConsolidationSubmitTool((payload) => {
        submission = payload;
      }),
    ],
    getSubmission: () => submission,
    maxTurns: MAX_CONSOLIDATION_SUBMIT_TURNS,
    ...(input.now == null ? {} : { now: input.now }),
  });

  return {
    systemPrompt,
    prompt,
    ...result,
  };
}

export type { PreparedMeditationBucket };
