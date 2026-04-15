import type { PreparedMeditationBucket } from "@/src/meditation/bucket-prep.js";
import type {
  ConsolidationDurability,
  ConsolidationPriority,
  ConsolidationPromotionDecision,
  MeditationFinding,
  MeditationFindingIssueType,
  MeditationFindingScopeHint,
} from "@/src/meditation/submit-tools.js";
import type { MeditationWindow } from "@/src/meditation/window.js";

export interface MeditationBucketPromptInput {
  currentDate: string;
  timezone: string;
  meditationWindow: Pick<MeditationWindow, "startAt" | "endAt" | "clippedByLookback">;
  bucket: PreparedMeditationBucket;
}

export interface MeditationBucketFindingContext {
  findingId: string;
  summary: string;
  issueType: MeditationFindingIssueType;
  scopeHint: MeditationFindingScopeHint;
  clusterIds: string[];
  evidenceSummary: string;
}

export interface MeditationRecentFindingHistory {
  date: string;
  runId: string;
  summary: string;
  issueType: MeditationFindingIssueType;
  scopeHint: MeditationFindingScopeHint;
  evidenceSummary: string;
}

export interface MeditationBucketHistoryStats {
  daysWithFindings: number;
  totalFindings: number;
  countsByIssueType: Partial<Record<MeditationFindingIssueType, number>>;
}

export interface MeditationConsolidationBucketPacket {
  bucketId: string;
  agentId: string;
  agentKind: "main" | "sub" | "shared" | "unknown";
  displayName: string | null;
  description: string | null;
  workdir: string | null;
  compactSummary: string | null;
  privateMemoryCurrent: string | null;
  bucketNote: string;
  currentFindings: MeditationBucketFindingContext[];
  recentHistory: MeditationRecentFindingHistory[];
  recentHistoryStats: MeditationBucketHistoryStats;
}

export interface MeditationConsolidationEvaluationPromptInput {
  currentDate: string;
  timezone: string;
  sharedMemoryCurrent: string;
  bucketPackets: MeditationConsolidationBucketPacket[];
}

export interface MeditationApprovedFinding {
  findingId: string;
  agentId: string;
  agentKind: "main" | "sub" | "shared" | "unknown";
  priority: ConsolidationPriority;
  durability: ConsolidationDurability;
  promotionDecision: Extract<ConsolidationPromotionDecision, "shared_memory" | "private_memory">;
  reason: string;
  summary: string;
  issueType: MeditationFindingIssueType;
  scopeHint: MeditationFindingScopeHint;
  evidenceSummary: string;
}

export interface MeditationConsolidationRewriteBucketPacket {
  bucketId: string;
  agentId: string;
  agentKind: "main" | "sub" | "shared" | "unknown";
  displayName: string | null;
  description: string | null;
  workdir: string | null;
  compactSummary: string | null;
  privateMemoryCurrent: string | null;
  approvedPrivateFindings: MeditationApprovedFinding[];
}

export interface MeditationConsolidationRewritePromptInput {
  currentDate: string;
  timezone: string;
  sharedMemoryCurrent: string;
  approvedSharedFindings: MeditationApprovedFinding[];
  bucketPackets: MeditationConsolidationRewriteBucketPacket[];
}

export function buildMeditationBucketSystemPrompt(): string {
  const lines = [
    "## Identity",
    "You are an internal Pokoclaw worker.",
    "You are running in the background, not talking to the user directly.",
    "Your job is to help Pokoclaw learn from recent usage and reduce future user friction.",
    "",
    "## Product Context",
    "- Pokoclaw is a long-lived multi-agent assistant system that helps one user across many tasks and many sessions.",
    '- Its long-term quality depends on learning from real friction, not only from explicit "please remember this" commands.',
    "- Meditation is the background review process that studies recent evidence and prepares cleaner inputs for durable memory decisions.",
    "",
    "## Pipeline Context",
    "- Earlier stages have already harvested facts and grouped them into one bucket for this SubAgent.",
    "- Your job in this call is bucket-level Triage + Synthesis.",
    "- This phase stays on the factual layer.",
    "- You may organize facts, compress them, and classify them.",
    "- You must not decide priority, durability, or whether something should enter durable memory.",
    "- You must not rewrite any memory file here.",
    "",
    "## What Counts As Success",
    "- Keep only the strongest user-friction signals.",
    "- Produce a concise factual note for later review.",
    "- Produce a small list of factual findings with conservative classification.",
    "- Be conservative when context is weak or ambiguous.",
    "",
    "## Hard Constraints",
    "- Start from user friction, not from tool logs alone.",
    "- Do not invent missing context.",
    "- If a finding cannot be confidently classified, use uncertain_or_mixed.",
    "- Do not output priority, durability, or any memory promotion decision.",
    "",
    "## Output Contract",
    "You must finish by calling submit with this exact schema:",
    "```json",
    "{",
    '  "note": "string",',
    '  "findings": [',
    "    {",
    '      "summary": "string",',
    '      "issue_type": "user_preference_signal | user_intent_shift | agent_workflow_issue | tool_or_source_quirk | system_or_config_issue | uncertain_or_mixed",',
    '      "scope_hint": "shared | subagent | session_only | uncertain",',
    '      "cluster_ids": ["string"],',
    '      "evidence_summary": "string"',
    "    }",
    "  ]",
    "}",
    "```",
  ];

  return lines.join("\n");
}

export function buildMeditationBucketUserPrompt(input: MeditationBucketPromptInput): string {
  const lines = [
    "## Current Run",
    `- Current date: ${input.currentDate}`,
    `- Time zone: ${input.timezone}`,
    `- Meditation window start: ${input.meditationWindow.startAt}`,
    `- Meditation window end: ${input.meditationWindow.endAt}`,
    `- Lookback clipped: ${input.meditationWindow.clippedByLookback ? "yes" : "no"}`,
    `- Bucket id: ${input.bucket.bucketId}`,
    `- Owner agent id: ${input.bucket.agentId ?? "shared"}`,
    `- Bucket score: ${input.bucket.score}`,
    "",
    "## SubAgent Profile",
    renderSubagentProfile(input.bucket),
    "",
    "## Bucket Evidence",
    renderBucketEvidence(input.bucket),
  ];

  return lines.join("\n");
}

export function buildMeditationConsolidationEvaluationSystemPrompt(): string {
  const lines = [
    "## Identity",
    "You are an internal Pokoclaw memory evaluator.",
    "You are running in the background, not talking to the user directly.",
    "Your job is to judge which current Meditation findings are worth promoting into durable memory.",
    "",
    "## Product Context",
    "- Pokoclaw is a long-lived multi-agent assistant system that helps one user across many tasks, sessions, projects, and SubAgents.",
    "- Meditation studies recent friction and improves future behavior.",
    "- This evaluation step is the judgment layer.",
    "",
    "## Responsibilities",
    "- Review today's findings together with same-agent recent history and current memory files.",
    "- Explicitly evaluate each current finding.",
    "- Decide whether it should stay in meditation, be promoted to shared memory, or be promoted to one SubAgent's private memory.",
    "- Do not rewrite any memory file in this step.",
    "",
    "## Decision Policy",
    "- Promotion is optional.",
    "- No promotion is a fully correct outcome.",
    "- Be conservative when evidence is weak or the pattern is not yet stable.",
    "- Use the recent same-agent history to judge whether the issue looks transient, recurring, or durable.",
    "- Use current shared/private memory to avoid promoting content that is already adequately covered.",
    "",
    "## Output Contract",
    "You must finish by calling submit with this exact schema:",
    "```json",
    "{",
    '  "evaluations": [',
    "    {",
    '      "finding_id": "string",',
    '      "priority": "low | medium | high",',
    '      "durability": "transient | recurring | durable",',
    '      "promotion_decision": "shared_memory | private_memory | keep_in_meditation",',
    '      "reason": "string"',
    "    }",
    "  ]",
    "}",
    "```",
  ];

  return lines.join("\n");
}

export function buildMeditationConsolidationEvaluationUserPrompt(
  input: MeditationConsolidationEvaluationPromptInput,
): string {
  const lines = [
    "## Current Run",
    `- Current date: ${input.currentDate}`,
    `- Time zone: ${input.timezone}`,
    `- Bucket packets: ${input.bucketPackets.length}`,
    "",
    "## Shared Memory Current",
    "<shared_memory_current>",
    input.sharedMemoryCurrent.trimEnd(),
    "</shared_memory_current>",
    "",
    "## Bucket Packets",
    ...input.bucketPackets.flatMap(renderEvaluationBucketPacket),
  ];

  return lines.join("\n");
}

export function buildMeditationConsolidationRewriteSystemPrompt(): string {
  const lines = [
    "## Identity",
    "You are an internal Pokoclaw memory rewrite worker.",
    "You are running in the background, not talking to the user directly.",
    "Your job is to rewrite durable memory files based only on already approved evaluation results.",
    "",
    "## Core Rule",
    "- Do not reevaluate the world from scratch.",
    "- Use only the approved findings below.",
    "- If no durable rewrite is needed, return shared_memory_rewrite as null and private_memory_rewrites as [].",
    "",
    "## Rewrite Policy",
    "- Treat existing memory as high-trust material.",
    "- You may merge overlap, tighten wording, and improve organization slightly.",
    "- You must not delete the substance of existing memory.",
    "- Preserve useful concrete details when they make the memory more actionable.",
    "",
    "## Routing Policy",
    "- Only SubAgents may receive private memory rewrites.",
    "- Shared-approved findings may influence only shared memory.",
    "- Private-approved findings may influence only the matching SubAgent private memory.",
    "- The main agent has no private memory target.",
    "- Main-agent approved findings may still influence shared memory.",
    "",
    "## Output Contract",
    "You must finish by calling submit with this exact schema:",
    "```json",
    "{",
    '  "shared_memory_rewrite": "string | null",',
    '  "private_memory_rewrites": [',
    "    {",
    '      "agent_id": "string",',
    '      "content": "string"',
    "    }",
    "  ]",
    "}",
    "```",
  ];

  return lines.join("\n");
}

export function buildMeditationConsolidationRewriteUserPrompt(
  input: MeditationConsolidationRewritePromptInput,
): string {
  const lines = [
    "## Current Run",
    `- Current date: ${input.currentDate}`,
    `- Time zone: ${input.timezone}`,
    `- Bucket packets with approved findings: ${input.bucketPackets.length}`,
    "",
    "## Shared Memory Current",
    "<shared_memory_current>",
    input.sharedMemoryCurrent.trimEnd(),
    "</shared_memory_current>",
    "",
    "## Approved Shared Findings",
    ...renderApprovedFindings(input.approvedSharedFindings),
    "",
    "## Approved Private Findings By Bucket",
    ...input.bucketPackets.flatMap(renderRewriteBucketPacket),
  ];

  return lines.join("\n");
}

function renderSubagentProfile(bucket: PreparedMeditationBucket): string {
  const profile = bucket.profile;
  if (profile == null) {
    return "<subagent_profile>\n- No concrete SubAgent profile exists for this bucket.\n</subagent_profile>";
  }

  const lines = [
    "<subagent_profile>",
    `- Agent id: ${profile.agentId}`,
    `- Kind: ${profile.kind}`,
    `- Display name: ${profile.displayName ?? "(none)"}`,
    `- Description: ${profile.description ?? "(none)"}`,
    `- Workdir: ${profile.workdir ?? "(none)"}`,
  ];
  if (profile.compactSummary != null) {
    lines.push(`- Compact summary: ${profile.compactSummary}`);
  }
  lines.push("</subagent_profile>");
  return lines.join("\n");
}

function renderBucketEvidence(bucket: PreparedMeditationBucket): string {
  return bucket.clusters.map((cluster) => renderClusterEvidence(cluster)).join("\n\n");
}

function renderClusterEvidence(cluster: PreparedMeditationBucket["clusters"][number]): string {
  switch (cluster.kind) {
    case "stop":
      return [
        `<cluster_evidence kind="stop" id="${cluster.id}">`,
        `- Stop count: ${cluster.stopCount}`,
        `- Time range: ${cluster.startedAt} -> ${cluster.endedAt}`,
        ...renderMessageWindow(cluster.contextMessages),
        "</cluster_evidence>",
      ].join("\n");
    case "task_failure":
      return [
        `<cluster_evidence kind="task_failure" id="${cluster.id}">`,
        `- Task run id: ${cluster.taskRunId}`,
        `- Status: ${cluster.status}`,
        `- Description: ${cluster.description ?? "(none)"}`,
        `- Result summary: ${cluster.resultSummary ?? "(none)"}`,
        `- Error text: ${cluster.errorText ?? "(none)"}`,
        ...renderMessageWindow(cluster.contextMessages),
        "</cluster_evidence>",
      ].join("\n");
    case "tool_burst":
      return [
        `<cluster_evidence kind="tool_burst" id="${cluster.id}">`,
        `- Failure count: ${cluster.count}`,
        `- Signatures: ${cluster.signatures.join(", ")}`,
        ...renderMessageWindow(cluster.contextMessages),
        "</cluster_evidence>",
      ].join("\n");
    case "tool_repeat":
      return [
        `<cluster_evidence kind="tool_repeat" id="${cluster.id}">`,
        `- Signature: ${cluster.signature}`,
        `- Repeat count: ${cluster.count}`,
        ...cluster.examples.flatMap((example, index) => [
          `- Example ${index + 1}: fact=${example.factId} session=${example.sessionId} seq=${example.seq} createdAt=${example.createdAt}`,
          ...renderMessageWindow(example.messageWindow),
        ]),
        "</cluster_evidence>",
      ].join("\n");
  }
}

function renderMessageWindow(
  messages: Array<{ id: string; role: string; messageType: string; createdAt: string }>,
): string[] {
  if (messages.length === 0) {
    return ["- Context messages: (none)"];
  }

  return [
    "- Context messages:",
    ...messages.map(
      (message) =>
        `  - [${message.createdAt}] ${message.role}/${message.messageType} id=${message.id}`,
    ),
  ];
}

function renderEvaluationBucketPacket(packet: MeditationConsolidationBucketPacket): string[] {
  return [
    `<bucket_packet bucket_id="${packet.bucketId}" agent_id="${packet.agentId}">`,
    `- Agent kind: ${packet.agentKind}`,
    `- Display name: ${packet.displayName ?? "(none)"}`,
    `- Description: ${packet.description ?? "(none)"}`,
    `- Workdir: ${packet.workdir ?? "(none)"}`,
    ...(packet.compactSummary == null ? [] : [`- Compact summary: ${packet.compactSummary}`]),
    "",
    "### Private Memory Current",
    ...(packet.privateMemoryCurrent == null
      ? [
          packet.agentKind === "sub"
            ? "- This SubAgent currently has no loaded private memory content."
            : "- This agent has no private memory target in this step.",
        ]
      : ["```md", packet.privateMemoryCurrent.trimEnd(), "```"]),
    "",
    "### Bucket Note",
    packet.bucketNote.trim().length === 0 ? "(empty note)" : packet.bucketNote.trimEnd(),
    "",
    "### Current Findings",
    ...renderCurrentFindings(packet.currentFindings),
    "",
    "### Recent Same-Agent History",
    ...renderRecentHistory(packet.recentHistory, packet.recentHistoryStats),
    "</bucket_packet>",
  ];
}

function renderRewriteBucketPacket(packet: MeditationConsolidationRewriteBucketPacket): string[] {
  return [
    `<bucket_packet bucket_id="${packet.bucketId}" agent_id="${packet.agentId}">`,
    `- Agent kind: ${packet.agentKind}`,
    `- Display name: ${packet.displayName ?? "(none)"}`,
    `- Description: ${packet.description ?? "(none)"}`,
    `- Workdir: ${packet.workdir ?? "(none)"}`,
    ...(packet.compactSummary == null ? [] : [`- Compact summary: ${packet.compactSummary}`]),
    "",
    "### Private Memory Current",
    ...(packet.privateMemoryCurrent == null
      ? ["- This agent has no private memory target in this step."]
      : ["```md", packet.privateMemoryCurrent.trimEnd(), "```"]),
    "",
    "### Approved Findings",
    ...renderApprovedFindings(packet.approvedPrivateFindings),
    "</bucket_packet>",
  ];
}

function renderCurrentFindings(findings: MeditationBucketFindingContext[]): string[] {
  if (findings.length === 0) {
    return ["- (none)"];
  }

  return findings.flatMap((finding) => [
    `- finding_id: ${finding.findingId}`,
    `  - summary: ${finding.summary}`,
    `  - issue_type: ${finding.issueType}`,
    `  - scope_hint: ${finding.scopeHint}`,
    `  - cluster_ids: ${finding.clusterIds.join(", ") || "(none)"}`,
    `  - evidence_summary: ${finding.evidenceSummary}`,
  ]);
}

function renderRecentHistory(
  history: MeditationRecentFindingHistory[],
  stats: MeditationBucketHistoryStats,
): string[] {
  const lines = [
    `- Days with findings: ${stats.daysWithFindings}`,
    `- Total recent findings: ${stats.totalFindings}`,
    "- Counts by issue type:",
    ...renderIssueTypeCounts(stats.countsByIssueType),
  ];

  if (history.length === 0) {
    lines.push("- Recent finding items: (none)");
    return lines;
  }

  lines.push("- Recent finding items:");
  lines.push(
    ...history.flatMap((entry) => [
      `  - [${entry.date}] ${entry.summary}`,
      `    - run_id: ${entry.runId}`,
      `    - issue_type: ${entry.issueType}`,
      `    - scope_hint: ${entry.scopeHint}`,
      `    - evidence_summary: ${entry.evidenceSummary}`,
    ]),
  );
  return lines;
}

function renderApprovedFindings(findings: MeditationApprovedFinding[]): string[] {
  if (findings.length === 0) {
    return ["- (none)"];
  }

  return findings.flatMap((finding) => [
    `- finding_id: ${finding.findingId}`,
    `  - summary: ${finding.summary}`,
    `  - issue_type: ${finding.issueType}`,
    `  - scope_hint: ${finding.scopeHint}`,
    `  - priority: ${finding.priority}`,
    `  - durability: ${finding.durability}`,
    `  - promotion_decision: ${finding.promotionDecision}`,
    `  - reason: ${finding.reason}`,
    `  - evidence_summary: ${finding.evidenceSummary}`,
  ]);
}

function renderIssueTypeCounts(
  counts: Partial<Record<MeditationFindingIssueType, number>>,
): string[] {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return ["  - (none)"];
  }

  return entries.map(([issueType, count]) => `  - ${issueType}: ${count}`);
}

export function buildMeditationFindingId(bucketId: string, findingIndex: number): string {
  return `${bucketId}/finding-${findingIndex + 1}`;
}

export function toMeditationBucketFindingContext(
  bucketId: string,
  findings: MeditationFinding[],
): MeditationBucketFindingContext[] {
  return findings.map((finding, index) => ({
    findingId: buildMeditationFindingId(bucketId, index),
    summary: finding.summary,
    issueType: finding.issue_type,
    scopeHint: finding.scope_hint,
    clusterIds: [...finding.cluster_ids],
    evidenceSummary: finding.evidence_summary,
  }));
}
