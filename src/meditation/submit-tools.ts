/**
 * Submit tool contracts for Meditation LLM calls.
 *
 * Each phase exposes exactly one "submit" tool with a strict schema so host
 * code can consume results deterministically.
 */
import { Type } from "@sinclair/typebox";

import { defineTool, type ToolDefinition, textToolResult } from "@/src/tools/core/types.js";

export type MeditationFindingIssueType =
  | "user_preference_signal"
  | "user_intent_shift"
  | "agent_workflow_issue"
  | "tool_or_source_quirk"
  | "system_or_config_issue"
  | "uncertain_or_mixed";

export type MeditationFindingScopeHint = "shared" | "subagent" | "session_only" | "uncertain";

export interface MeditationFinding {
  summary: string;
  issue_type: MeditationFindingIssueType;
  scope_hint: MeditationFindingScopeHint;
  cluster_ids: string[];
  evidence_summary: string;
  examples: string[];
}

export interface BucketMeditationSubmit {
  note: string;
  findings: MeditationFinding[];
}

export interface ConsolidationMemoryRewrite {
  agent_id: string;
  content: string;
}

export type ConsolidationPriority = "low" | "medium" | "high";
export type ConsolidationDurability = "transient" | "recurring" | "durable";
export type ConsolidationPromotionDecision =
  | "shared_memory"
  | "private_memory"
  | "keep_in_meditation";

export interface ConsolidationFindingEvaluation {
  finding_id: string;
  priority: ConsolidationPriority;
  durability: ConsolidationDurability;
  promotion_decision: ConsolidationPromotionDecision;
  reason: string;
}

export interface ConsolidationEvaluationSubmit {
  evaluations: ConsolidationFindingEvaluation[];
}

export interface ConsolidationRewriteSubmit {
  shared_memory_rewrite: string | null;
  private_memory_rewrites: ConsolidationMemoryRewrite[];
}

const MEDITATION_FINDING_SCHEMA = Type.Object(
  {
    summary: Type.String(),
    issue_type: Type.Union([
      Type.Literal("user_preference_signal"),
      Type.Literal("user_intent_shift"),
      Type.Literal("agent_workflow_issue"),
      Type.Literal("tool_or_source_quirk"),
      Type.Literal("system_or_config_issue"),
      Type.Literal("uncertain_or_mixed"),
    ]),
    scope_hint: Type.Union([
      Type.Literal("shared"),
      Type.Literal("subagent"),
      Type.Literal("session_only"),
      Type.Literal("uncertain"),
    ]),
    cluster_ids: Type.Array(Type.String()),
    evidence_summary: Type.String(),
    examples: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const BUCKET_MEDITATION_SUBMIT_SCHEMA = Type.Object(
  {
    note: Type.String(),
    findings: Type.Array(MEDITATION_FINDING_SCHEMA),
  },
  { additionalProperties: false },
);

export const CONSOLIDATION_EVALUATION_SUBMIT_SCHEMA = Type.Object(
  {
    evaluations: Type.Array(
      Type.Object(
        {
          finding_id: Type.String(),
          priority: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
          durability: Type.Union([
            Type.Literal("transient"),
            Type.Literal("recurring"),
            Type.Literal("durable"),
          ]),
          promotion_decision: Type.Union([
            Type.Literal("shared_memory"),
            Type.Literal("private_memory"),
            Type.Literal("keep_in_meditation"),
          ]),
          reason: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const CONSOLIDATION_REWRITE_SUBMIT_SCHEMA = Type.Object(
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
      "Submit the final bucket meditation result with a markdown note and factual findings.",
    inputSchema: BUCKET_MEDITATION_SUBMIT_SCHEMA,
    execute(_context, args) {
      onSubmit(args);
      return textToolResult("Bucket meditation result submitted.");
    },
  });
}

export function createConsolidationEvaluationSubmitTool(
  onSubmit: (payload: ConsolidationEvaluationSubmit) => void,
): ToolDefinition<ConsolidationEvaluationSubmit> {
  return defineTool({
    name: "submit",
    description:
      "Submit the consolidation evaluation result with explicit priority, durability, and promotion decisions for the current findings.",
    inputSchema: CONSOLIDATION_EVALUATION_SUBMIT_SCHEMA,
    execute(_context, args) {
      onSubmit(args);
      return textToolResult("Meditation consolidation evaluation submitted.");
    },
  });
}

export function createConsolidationRewriteSubmitTool(
  onSubmit: (payload: ConsolidationRewriteSubmit) => void,
): ToolDefinition<ConsolidationRewriteSubmit> {
  return defineTool({
    name: "submit",
    description:
      "Submit the final consolidation rewrite with canonical rewrites for shared and touched private memory files.",
    inputSchema: CONSOLIDATION_REWRITE_SUBMIT_SCHEMA,
    execute(_context, args) {
      onSubmit(args);
      return textToolResult("Meditation consolidation rewrite submitted.");
    },
  });
}
