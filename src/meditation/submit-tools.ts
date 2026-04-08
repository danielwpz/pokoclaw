/**
 * Submit tool contracts for Meditation LLM calls.
 *
 * Each phase exposes exactly one "submit" tool with a strict schema so host
 * code can consume results deterministically.
 */
import { Type } from "@sinclair/typebox";

import { defineTool, type ToolDefinition, textToolResult } from "@/src/tools/core/types.js";

export interface BucketMeditationSubmit {
  note: string;
  memory_candidates: string[];
}

export interface ConsolidationMemoryRewrite {
  agent_id: string;
  content: string;
}

export interface ConsolidationMeditationSubmit {
  shared_memory_rewrite: string | null;
  private_memory_rewrites: ConsolidationMemoryRewrite[];
}

export const BUCKET_MEDITATION_SUBMIT_SCHEMA = Type.Object(
  {
    note: Type.String(),
    memory_candidates: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const CONSOLIDATION_MEDITATION_SUBMIT_SCHEMA = Type.Object(
  {
    shared_memory_rewrite: Type.Union([Type.String(), Type.Null()]),
    private_memory_rewrites: Type.Array(
      Type.Object(
        {
          agent_id: Type.String(),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export function createBucketSubmitTool(
  onSubmit: (payload: BucketMeditationSubmit) => void,
): ToolDefinition<BucketMeditationSubmit> {
  return defineTool({
    name: "submit",
    description:
      "Submit the final bucket meditation result with a markdown note and candidate durable lessons.",
    inputSchema: BUCKET_MEDITATION_SUBMIT_SCHEMA,
    execute(_context, args) {
      onSubmit(args);
      return textToolResult("Bucket meditation result submitted.");
    },
  });
}

export function createConsolidationSubmitTool(
  onSubmit: (payload: ConsolidationMeditationSubmit) => void,
): ToolDefinition<ConsolidationMeditationSubmit> {
  return defineTool({
    name: "submit",
    description:
      "Submit the final consolidation result with canonical rewrites for shared and touched private memory files.",
    inputSchema: CONSOLIDATION_MEDITATION_SUBMIT_SCHEMA,
    execute(_context, args) {
      onSubmit(args);
      return textToolResult("Meditation consolidation result submitted.");
    },
  });
}
