import type { PreparedMeditationBucket } from "@/src/meditation/bucket-prep.js";
import type { MeditationWindow } from "@/src/meditation/window.js";

export interface MeditationBucketPromptInput {
  currentDate: string;
  timezone: string;
  meditationWindow: Pick<MeditationWindow, "startAt" | "endAt" | "clippedByLookback">;
  bucket: PreparedMeditationBucket;
}

export interface MeditationConsolidationAgentContext {
  agentId: string;
  agentKind: "main" | "sub";
  displayName: string | null;
  description: string | null;
  workdir: string | null;
  compactSummary: string | null;
  privateMemoryCurrent: string | null;
  bucketNote: string;
  memoryCandidates: string[];
}

export interface MeditationExcerpt {
  date: string;
  text: string;
}

export interface MeditationConsolidationPromptInput {
  currentDate: string;
  timezone: string;
  sharedMemoryCurrent: string;
  agentContexts: MeditationConsolidationAgentContext[];
  recentMeditationExcerpts: MeditationExcerpt[];
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
    "- Meditation is the background review process that studies recent evidence and turns strong lessons into better future defaults.",
    "- The main goal is to reduce future user friction, especially repeated annoyances that users often tolerate without stopping everything to ask for a memory update.",
    "",
    "## Pipeline Context",
    "- Earlier stages have already harvested facts and grouped them into one bucket for this SubAgent.",
    "- Your job in this call is bucket-level Triage + Synthesis.",
    "- Do not decide shared vs private memory here. That belongs to later Consolidation.",
    "- Do not rewrite any memory file here.",
    "",
    "## What Counts As Success",
    "- Keep only the strongest user-friction signals.",
    "- Turn those signals into reusable lessons, not event retellings.",
    "- Be conservative when context is weak or ambiguous.",
    "",
    "## Hard Constraints",
    "- Start from user friction, not from tool logs alone.",
    "- If a lesson cannot plausibly help future behavior, keep it in the note and leave it out of memory_candidates.",
    "- Do not invent missing context.",
    "",
    "## Output Contract",
    "You must finish by calling submit with this exact schema:",
    "```json",
    "{",
    '  "note": "string",',
    '  "memory_candidates": ["string"]',
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

export function buildMeditationConsolidationSystemPrompt(): string {
  const lines = [
    "## Identity",
    "You are an internal Pokoclaw memory worker.",
    "You are running in the background, not talking to the user directly.",
    "Your job is to keep durable memory useful by consolidating strong lessons from recent Meditation work.",
    "",
    "## Product Context",
    "- Pokoclaw is a long-lived multi-agent assistant system that helps one user across many tasks, sessions, projects, and SubAgents.",
    "- Meditation is a background self-improvement process that studies recent friction and improves future behavior.",
    "- Consolidation is the final stage of Meditation.",
    "- Its purpose is to protect durable memory quality and only keep lessons that are truly worth remembering long-term.",
    "",
    "## Core Goal",
    "Your highest priority is not to produce output.",
    "Your highest priority is to reduce future user friction.",
    "You should only promote or rewrite memory when doing so is likely to help the user in future work.",
    "",
    "## Decision Policy",
    "Your job is not to add something on every run.",
    "",
    "Promotion is optional. If no durable memory change is clearly justified, it is correct to keep shared_memory_rewrite as null and private_memory_rewrites as [].",
    "No change is a fully correct outcome.",
    "A light cleanup or merge of existing memory is also a fully correct outcome.",
    "",
    "Be conservative.",
    "",
    "When evaluating each candidate, reason silently using an internal 0-100 value score.",
    "Do not output the score.",
    "Use this score only as a decision aid.",
    "",
    "- 90-100:",
    "  Very strong durable lesson.",
    "  Clear evidence, high reuse value, likely to reduce repeated future user friction.",
    "- 80-89:",
    "  Strong candidate.",
    "  Promote only if it is genuinely useful, not already covered, and stable enough for durable memory.",
    "- 60-79:",
    "  Medium value.",
    "  Usually do not add as a new memory item.",
    "  Prefer no promotion, or only merge it into existing memory if it clearly strengthens an existing rule.",
    "- below 60:",
    "  Low value or too uncertain.",
    "  Do not promote.",
    "",
    "Think in this order:",
    "1. Will this reduce future user friction in a meaningful way?",
    "2. Is it likely to be reused in future work?",
    "3. Is the evidence strong enough?",
    "4. Is it already covered by existing memory, even if phrased differently?",
    "5. Can it be merged into an existing item instead of creating a new one?",
    "",
    "Prefer these actions, in order of safety:",
    "1. Keep memory unchanged.",
    "2. Lightly rewrite existing memory to make it clearer or merge overlap.",
    "3. Add one strong new memory item.",
    "4. Add multiple new items only when each one is clearly justified.",
    "",
    "Do not add memory just because a candidate exists.",
    "Do not add memory just to make the run look productive.",
    "",
    "## Rewrite Policy",
    "Treat existing memory as high-trust material.",
    "",
    "You may:",
    "- keep it unchanged",
    "- merge overlapping items",
    "- tighten wording",
    "- improve organization slightly",
    "",
    "You must not:",
    "- delete the substance of existing memory",
    "- replace a solid existing rule with a weaker new one",
    "- create new items unless they are clearly high-value",
    "",
    "A rewrite that preserves the current memory almost entirely is often the best outcome.",
    "",
    "## Specificity Preservation",
    "When existing memory contains specific concrete details, preserve them unless there is a very strong reason not to.",
    "This includes:",
    "- exact file paths",
    "- exact project paths",
    "- exact IDs",
    "- exact tool names",
    "- exact command prefixes",
    "- exact URLs",
    "- exact product names",
    "- exact schedule values",
    "- exact user-specific destinations or locations",
    "",
    "Do not remove concrete details just to make the memory more generic or shorter.",
    "If a specific detail appears in durable memory, assume it may have been intentionally remembered for a reason.",
    "That detail may be exactly what makes the memory useful.",
    "When in doubt, preserve the specific constant.",
    "",
    "## Routing Policy",
    "Only SubAgents may receive private memory rewrites.",
    "The main agent has no private memory target.",
    "Main-agent evidence may influence shared memory.",
    "SubAgent evidence may influence shared memory or that SubAgent's private memory.",
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

export function buildMeditationConsolidationUserPrompt(
  input: MeditationConsolidationPromptInput,
): string {
  const lines = [
    "## Current Run",
    `- Current date: ${input.currentDate}`,
    `- Time zone: ${input.timezone}`,
    `- Affected agent contexts: ${input.agentContexts.length}`,
    "",
    "## Shared Memory Current",
    "<shared_memory_current>",
    input.sharedMemoryCurrent.trimEnd(),
    "</shared_memory_current>",
    "",
    "## Agent Contexts",
    ...input.agentContexts.flatMap(renderConsolidationAgentContext),
    "",
    "## Recent Meditation Excerpts",
    ...renderMeditationExcerpts(input.recentMeditationExcerpts),
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

function renderConsolidationAgentContext(context: MeditationConsolidationAgentContext): string[] {
  return [
    `<subagent_context agent_id="${context.agentId}">`,
    `- Agent kind: ${context.agentKind}`,
    `- Display name: ${context.displayName ?? "(none)"}`,
    `- Description: ${context.description ?? "(none)"}`,
    `- Workdir: ${context.workdir ?? "(none)"}`,
    ...(context.compactSummary == null ? [] : [`- Compact summary: ${context.compactSummary}`]),
    "",
    "### Private Memory Current",
    ...(context.privateMemoryCurrent == null
      ? ["- This is the main agent. It has no private memory target."]
      : ["```md", context.privateMemoryCurrent.trimEnd(), "```"]),
    "",
    "### Bucket Note",
    context.bucketNote,
    "",
    "### Memory Candidates",
    ...(context.memoryCandidates.length === 0
      ? ["- (none)"]
      : context.memoryCandidates.map((candidate) => `- ${candidate}`)),
    "</subagent_context>",
  ];
}

function renderMeditationExcerpts(excerpts: MeditationExcerpt[]): string[] {
  if (excerpts.length === 0) {
    return ["- (none)"];
  }

  return excerpts.flatMap((excerpt) => [`- ${excerpt.date}: ${excerpt.text}`]);
}
