import { createHash } from "node:crypto";

import type { PreparedMeditationBucket } from "@/src/meditation/bucket-prep.js";
import { summarizeMeditationContextMessage } from "@/src/meditation/message-context.js";
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
  examples: string[];
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
  examples: string[];
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
    "## Facts Vs Judgments",
    "- A fact is something directly supported by the bucket evidence.",
    "- A judgment is an opinion about importance, long-term value, root cause, what should change, or what should be remembered.",
    "- This step is for facts, not judgments.",
    "",
    "### Facts: allowed",
    '- "The agent hit 3 permission_denied tool results in one session."',
    '- "The user stopped the run twice within 2 minutes."',
    '- "The task ended blocked after the agent reported tool-environment issues."',
    '- "The same schedule_task_not_found error appeared across 4 sessions."',
    '- "The agent repeated one method several times, then switched to a different method and later tool calls succeeded."',
    "",
    "### Judgments: not allowed here",
    '- "This is the core problem."',
    '- "This should go into memory."',
    '- "This is durable."',
    '- "The agent should switch strategy earlier."',
    '- "This needs to be fixed by changing X."',
    '- "The successful later step proves the root cause was Y."',
    "",
    "## Issue Type Guide",
    "- user_preference_signal:",
    "  Use when the evidence shows a stable user preference or stable user-facing collaboration constraint.",
    '  Example: the user repeatedly redirects the assistant to "lead with diagnosis first" across runs.',
    "  Not this: one frustrated stop in a single session.",
    "- user_intent_shift:",
    "  Use when the user changed direction or stopped this specific run, but there is not enough evidence that it is a durable preference.",
    "  Example: the user stops a run and moves to a different task.",
    "  Not this: the same preference or constraint repeated across sessions.",
    "- agent_workflow_issue:",
    "  Use when the agent itself repeatedly follows a poor method, wrong procedure, wrong naming, or overly broad permission strategy.",
    "  Example: repeatedly requesting bash.full_access for a browsing task.",
    "  Example: repeatedly using the wrong scheduled task name.",
    "  Not this: a website or external tool has an inherent limitation.",
    "- tool_or_source_quirk:",
    "  Use when a tool, website, data source, browser environment, or external system has its own limitation or special behavior.",
    "  Example: a path truly does not exist.",
    "  Example: a source returns 404 or a site blocks scraping.",
    "  Not this: the agent keeps choosing the wrong tool or keeps requesting the wrong permission scope.",
    "- system_or_config_issue:",
    "  Use when the evidence points to Pokoclaw configuration, task registration, platform setup, or product wiring problems.",
    "  Example: a registered task name does not match what the agent is invoking.",
    "  Example: a required local tool is missing from the environment.",
    "- uncertain_or_mixed:",
    "  Use when the evidence could fit multiple categories or is too weak to classify confidently.",
    "",
    "## Scope Hint Guide",
    "- shared: the finding is not specific to one subagent and would plausibly matter across the system.",
    "- subagent: the finding is mainly about one specific subagent's work style, local tooling, or task domain.",
    "- session_only: the finding appears local to this run or session and should not be generalized yet.",
    "- uncertain: use when the scope cannot be determined confidently from the evidence.",
    "",
    "## How To Work",
    "1. Read the bucket evidence and identify the strongest repeated or user-visible friction signals.",
    "2. Rewrite those signals as plain factual observations.",
    "3. Classify each finding conservatively using issue_type and scope_hint.",
    "4. Stop before value judgment. Do not say what should be remembered, prioritized, fixed, or changed.",
    "5. If the evidence shows a repeated-failure pattern followed by a later change in method, include both the repeated failure pattern and the later changed action as facts.",
    "6. For each finding, include 1 to 3 short factual examples from the evidence.",
    "",
    "## Repeated Failure And Later Recovery",
    "- In many good buckets, the useful pattern is not only the failure itself.",
    "- It is often: repeated failed attempts -> user correction or agent method change -> later successful attempts.",
    "- Treat that full sequence as factual evidence.",
    "- Record what repeated, what changed later, and what later succeeded.",
    "- Do not over-claim. Later success does not automatically prove a root cause.",
    "- You may say that a different action happened later and later tool calls succeeded. Do not say that this fully explains why the earlier errors happened unless the evidence directly proves it.",
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
    "- Do not turn the note into root-cause analysis, durable lessons, or a repair plan.",
    "- Do not prescribe fixes or say what should be changed.",
    "- Keep findings anchored to observable facts: what happened, where, how often, and with what evidence.",
    "- For each finding, examples should make the evidence concrete: a short user quote, a short error snippet, or a short later-success snippet.",
    "- Examples are evidence, not lessons.",
    "- Prefer wording like 'X happened', 'Y repeated', 'Z was observed' over wording like 'therefore', 'the problem is', 'this means', or 'should'.",
    "- In both note and findings, avoid judgment-heavy verbs such as 'captures', 'shows', 'indicates', 'proves', 'demonstrates', 'reveals', or 'core problem'.",
    "- In both note and findings, avoid incident-summary phrasing such as 'this bucket captures friction', 'the task failed because', or 'the agent learned'.",
    "- Prefer concrete factual phrasing such as 'X repeated N times', 'the user said ...', 'later the agent switched to ...', or 'later tool calls succeeded'.",
    "- If a finding cannot be confidently classified, use uncertain_or_mixed.",
    "- Do not output priority, durability, or any memory promotion decision.",
    "",
    "## Style Contract",
    "- The note should read like a factual incident digest, not an analysis report.",
    "- The note may mention sessions, counts, quoted user corrections, and later successful actions.",
    "- The findings summary should be one factual sentence each.",
    "- Each finding should include 1 to 3 short factual examples.",
    "- If a finding includes later success, phrase it as observed sequence, not as a lesson.",
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
    '      "evidence_summary": "string",',
    '      "examples": ["string"]',
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
    "- Only treat a finding as promotion-worthy when the evidence is strong enough for both high priority and durable memory value.",
    "- If a finding is only medium priority, still situational, or still too environment-specific, keep it in meditation.",
    '- If you cannot imagine rewriting the finding as a short future-facing rule such as "Before X, verify Y" or "Do not Z; use A instead", keep it in meditation.',
    "- Use the finding examples to check whether the evidence is concrete enough to trust.",
    "- Strong findings usually have examples that show repeated failure, user correction, or a later method change.",
    "- Copy each finding_id exactly as it appears in Current Findings.",
    "- Do not reconstruct, shorten, or paraphrase a finding_id.",
    "- Before submit, verify that every current finding_id appears exactly once in your evaluations array.",
    "",
    "## What Good Durable Memory Looks Like",
    "- A good durable memory is a short future-facing rule.",
    "- It helps future behavior without retelling the incident.",
    "- It should usually fit in 1 to 3 bullets.",
    "- It should say what to check, avoid, or do next time.",
    "",
    "### Good memory shape",
    '- "Before scheduling this task, verify the exact registered task name."',
    '- "For this browsing task, request narrow browser permissions before asking for full shell access."',
    "",
    "### Bad memory shape",
    '- "This failed 4 times across sessions a and b on 2026-04-15T05:33:03Z."',
    '- "The task was blocked because..."',
    '- "This affects the primary function..."',
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
    "Your job is to propose durable Repeat-Use Lessons based only on already approved evaluation results.",
    "",
    "## Core Rule",
    "- Do not reevaluate the world from scratch.",
    "- Use only the approved findings below.",
    "- You are not rewriting whole files directly.",
    "- You are proposing the final Repeat-Use Lessons section content for the targets that should change.",
    "- If no durable rewrite is needed, return shared_repeat_use_lessons as null and private_repeat_use_lessons as [].",
    "",
    "## Rewrite Policy",
    "- Treat existing memory as high-trust material.",
    "- You may merge overlap, tighten wording, and improve organization inside Repeat-Use Lessons.",
    "- Preserve the substance of useful existing lessons when they still belong in the final Repeat-Use Lessons section.",
    "- Write durable future-facing rules, not incident reports.",
    "- Keep durable lessons short and reusable.",
    "- The final Repeat-Use Lessons section should usually fit in 1 to 3 bullets for each target.",
    "- Prefer rules such as 'Before X, verify Y', 'Do not Z; use A instead', or 'When X happens, check Y first.'",
    "- Avoid retelling one incident. Extract the future-facing rule instead.",
    "",
    "## Learn The Strategy, Not The Incident",
    "- Durable memory is for future behavior, not for replaying past runs.",
    "- If the evidence shows repeated failure followed by a later method change, write the future-facing strategy implied by that change.",
    "- Use the approved finding examples as anchors. They show the concrete failure, user correction, or later successful change that supports the rule.",
    "- Do not memorize the exact incident path unless that exact path is the durable rule.",
    "- Do not memorize exact seq numbers, exact sessions, or exact counts.",
    "- Generalize one level above the incident:",
    '  - Good: "For browser tasks, use simple approved command prefixes instead of full executable paths when requesting bash permissions."',
    '  - Bad: "The user rejected full path prefixes 4 times on 2026-04-15 and later accepted agent-browser --help."',
    '  - Good: "When shell-wide permissions are denied, switch earlier to narrower browser-specific or split-command execution."',
    "  - Bad: \"After asking '有必要用 python 吗', the agent switched to web_fetch and grep and then bash succeeded.\"",
    "",
    "## Rewrite Style",
    "- Prefer one clean rule over three explanatory bullets.",
    "- Prefer imperative or check-style wording.",
    "- Keep each new lesson self-contained and short.",
    "- If an approved finding cannot be rewritten as a short future-facing rule, leave that target unchanged.",
    "- For every proposed rule, include the supporting finding ids, a short explanation of why the rule is generalizable, and 1 to 2 concrete evidence examples.",
    "",
    "## Good Rewrite Examples",
    '- Good: "Before scheduling this summary task, verify the exact registered task name."',
    '- Good: "For browsing tasks, request narrow browser permissions before shell-wide permissions."',
    '- Good: "When bash.full_access is repeatedly denied for a browsing workflow, switch to simpler approved prefixes or narrower browser commands instead of retrying the same broad request."',
    "",
    "## Bad Rewrite Examples",
    '- Bad: "The scheduled task failed 4 times across sessions 7d3e814c and aec91bc2 on 2026-04-15T05:33:03Z."',
    '- Bad: "This affects the subagent\'s primary function..."',
    '- Bad: "The task was blocked because the agent-browser was missing and Chrome profile was locked..."',
    '- Bad: "After seq 18 the user said X, then seq 29 succeeded, so remember this exact command string."',
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
    '  "shared_repeat_use_lessons": [',
    "    {",
    '      "rule_text": "string",',
    '      "supported_finding_ids": ["string"],',
    '      "why_generalizable": "string",',
    '      "evidence_examples": ["string"]',
    "    }",
    "  ] | null,",
    '  "private_repeat_use_lessons": [',
    "    {",
    '      "agent_id": "string",',
    '      "lessons": [',
    "        {",
    '          "rule_text": "string",',
    '          "supported_finding_ids": ["string"],',
    '          "why_generalizable": "string",',
    '          "evidence_examples": ["string"]',
    "        }",
    "      ]",
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
        ...(cluster.episodeTimeline == null
          ? ["- Episode timeline: (none)"]
          : renderEpisodeTimeline(cluster.episodeTimeline)),
        "</cluster_evidence>",
      ].join("\n");
    case "tool_repeat":
      return [
        `<cluster_evidence kind="tool_repeat" id="${cluster.id}">`,
        `- Signature: ${cluster.signature}`,
        `- Repeat count: ${cluster.count}`,
        ...(cluster.episodes.length === 0
          ? []
          : cluster.episodes.flatMap((episode, index) => [
              `- Episode ${index + 1}: session=${episode.sessionId} seq=${episode.startSeq}-${episode.endSeq} trigger=${episode.triggerStartSeq}-${episode.triggerEndSeq} failedToolResults=${episode.failedToolResults}/${episode.totalToolResults}`,
              ...renderEpisodeTimeline(episode, "  "),
            ])),
        ...cluster.examples.flatMap((example, index) => [
          `- Example ${index + 1}: fact=${example.factId} session=${example.sessionId} seq=${example.seq} createdAt=${example.createdAt}`,
          ...renderMessageWindow(example.messageWindow),
        ]),
        "</cluster_evidence>",
      ].join("\n");
  }
}

function renderMessageWindow(
  messages: Array<{
    id: string;
    role: string;
    messageType: string;
    createdAt: string;
    payloadJson?: string;
  }>,
): string[] {
  if (messages.length === 0) {
    return ["- Context messages: (none)"];
  }

  return [
    "- Context messages:",
    ...messages.map((message) => {
      const summary =
        typeof message.payloadJson === "string"
          ? summarizeMeditationContextMessage({
              seq: 0,
              createdAt: message.createdAt,
              role: message.role,
              messageType: message.messageType,
              payloadJson: message.payloadJson,
            })
          : null;
      return `  - [${message.createdAt}] ${message.role}/${message.messageType} id=${message.id}${summary == null || summary.length === 0 ? "" : ` :: ${summary}`}`;
    }),
  ];
}

function renderEpisodeTimeline(
  episode: {
    sessionId: string;
    startSeq: number;
    endSeq: number;
    triggerStartSeq: number;
    triggerEndSeq: number;
    triggerKinds: string[];
    failedToolResults: number;
    totalToolResults: number;
    events: Array<{
      seq: number;
      createdAt: string;
      role: string;
      messageType: string;
      summary: string;
    }>;
  },
  prefix = "",
): string[] {
  return [
    `${prefix}- Episode session: ${episode.sessionId}`,
    `${prefix}- Episode seq range: ${episode.startSeq}-${episode.endSeq}`,
    `${prefix}- Trigger seq range: ${episode.triggerStartSeq}-${episode.triggerEndSeq}`,
    `${prefix}- Trigger kinds: ${episode.triggerKinds.join(", ")}`,
    `${prefix}- Tool results in episode: ${episode.failedToolResults}/${episode.totalToolResults} failed`,
    `${prefix}- Event timeline:`,
    ...episode.events.map(
      (event) =>
        `${prefix}  - [${event.seq}] ${event.createdAt} ${event.role}/${event.messageType}: ${event.summary}`,
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
    "  - examples:",
    ...(finding.examples.length === 0
      ? ["    - (none)"]
      : finding.examples.map((example) => `    - ${example}`)),
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
    "  - examples:",
    ...(finding.examples.length === 0
      ? ["    - (none)"]
      : finding.examples.map((example) => `    - ${example}`)),
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
  const bucketKey = createHash("sha1").update(bucketId).digest("hex").slice(0, 8);
  return `${bucketKey}-f${findingIndex + 1}`;
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
    examples: [...finding.examples],
  }));
}
