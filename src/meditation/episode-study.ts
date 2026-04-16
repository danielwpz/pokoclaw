import { summarizeMeditationContextMessage } from "@/src/meditation/message-context.js";
import { TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE } from "@/src/shared/tool-result-codes.js";

export interface EpisodeStudyMessageRow {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  messageType: string;
  visibility: string | null;
  createdAt: string;
  payloadJson: string;
}

export interface EpisodeStudySessionInfo {
  sessionId: string;
  ownerAgentId: string | null;
  agentDisplayName: string | null;
  failedToolResultCount: number;
}

export interface EpisodeStudyStrategyConfig {
  id: string;
  description: string;
  consecutiveFailuresThreshold: number | null;
  densityWindowSize: number | null;
  densityFailureThreshold: number | null;
  preContextMessages: number;
  postContextMessages: number;
  postContextMaxMinutes: number;
  mergeGapMessages: number;
  maxEventsPerEpisode: number;
}

export interface EpisodeStudyEpisode {
  id: string;
  sessionId: string;
  startSeq: number;
  endSeq: number;
  triggerStartSeq: number;
  triggerEndSeq: number;
  triggerKinds: string[];
  totalToolResults: number;
  failedToolResults: number;
  events: EpisodeStudyRenderedEvent[];
}

export interface EpisodeStudyRenderedEvent {
  seq: number;
  createdAt: string;
  role: string;
  messageType: string;
  summary: string;
}

type ParsedToolResultPayload = {
  isError?: unknown;
  details?: {
    code?: unknown;
  };
};

interface ParsedToolResultEntry {
  row: EpisodeStudyMessageRow;
  messageIndex: number;
  isError: boolean;
}

interface TriggerRange {
  startMessageIndex: number;
  endMessageIndex: number;
  triggerKinds: string[];
}

export const DEFAULT_EPISODE_STUDY_STRATEGIES: EpisodeStudyStrategyConfig[] = [
  {
    id: "consecutive-tight",
    description:
      "Strict consecutive failures only. Good for obvious meltdown runs, but may miss high-friction sessions with mixed success/failure.",
    consecutiveFailuresThreshold: 2,
    densityWindowSize: null,
    densityFailureThreshold: null,
    preContextMessages: 2,
    postContextMessages: 8,
    postContextMaxMinutes: 3,
    mergeGapMessages: 1,
    maxEventsPerEpisode: 18,
  },
  {
    id: "density-5of2",
    description:
      "High-density failures: any 5 tool results containing at least 2 failures. Better at catching mixed success/failure churn without dragging in too much setup noise.",
    consecutiveFailuresThreshold: null,
    densityWindowSize: 5,
    densityFailureThreshold: 2,
    preContextMessages: 2,
    postContextMessages: 8,
    postContextMaxMinutes: 3,
    mergeGapMessages: 2,
    maxEventsPerEpisode: 18,
  },
  {
    id: "hybrid-balanced",
    description:
      "Union of strict consecutive failures and 5-of-2 density. Intended as the balanced default candidate for meditation friction episodes.",
    consecutiveFailuresThreshold: 2,
    densityWindowSize: 5,
    densityFailureThreshold: 2,
    preContextMessages: 2,
    postContextMessages: 8,
    postContextMaxMinutes: 3,
    mergeGapMessages: 2,
    maxEventsPerEpisode: 18,
  },
];

const defaultMeditationEpisodeExtractionStrategy = DEFAULT_EPISODE_STUDY_STRATEGIES.find(
  (strategy) => strategy.id === "hybrid-balanced",
);

if (defaultMeditationEpisodeExtractionStrategy == null) {
  throw new Error("Missing default meditation episode extraction strategy: hybrid-balanced");
}

export const DEFAULT_MEDITATION_EPISODE_EXTRACTION_STRATEGY: EpisodeStudyStrategyConfig =
  defaultMeditationEpisodeExtractionStrategy;

export function extractEpisodeStudyEpisodes(
  rows: EpisodeStudyMessageRow[],
  strategy: EpisodeStudyStrategyConfig,
): EpisodeStudyEpisode[] {
  const filteredRows = rows.filter((row) => !isHarvestIgnoredToolResultRow(row));
  if (filteredRows.length === 0) {
    return [];
  }

  const parsedToolResults = collectParsedToolResults(filteredRows);
  if (parsedToolResults.length === 0) {
    return [];
  }

  const triggerRanges = mergeTriggerRanges(
    [
      ...buildConsecutiveFailureTriggers(parsedToolResults, strategy),
      ...buildDensityTriggers(parsedToolResults, strategy),
    ],
    strategy.mergeGapMessages,
  );

  return triggerRanges.map((trigger, index) => {
    const startIndex = Math.max(0, trigger.startMessageIndex - strategy.preContextMessages);
    const desiredEndIndex = Math.min(
      filteredRows.length - 1,
      trigger.endMessageIndex + strategy.postContextMessages,
    );
    const timeCappedEndIndex = capEndIndexByElapsedMinutes({
      rows: filteredRows,
      startIndex: trigger.startMessageIndex,
      endIndex: desiredEndIndex,
      maxMinutes: strategy.postContextMaxMinutes,
    });
    const endIndex = Math.min(
      timeCappedEndIndex,
      startIndex + Math.max(0, strategy.maxEventsPerEpisode - 1),
    );
    const episodeRows = filteredRows.slice(startIndex, endIndex + 1);
    const episodeToolResults = collectParsedToolResults(episodeRows);
    const firstRow = episodeRows[0];
    const lastRow = episodeRows.at(-1);
    if (firstRow == null || lastRow == null) {
      throw new Error("episode extraction produced an empty row slice");
    }

    return {
      id: `${shortId(firstRow.sessionId)}-ep${index + 1}`,
      sessionId: firstRow.sessionId,
      startSeq: firstRow.seq,
      endSeq: lastRow.seq,
      triggerStartSeq: filteredRows[trigger.startMessageIndex]?.seq ?? firstRow.seq,
      triggerEndSeq: filteredRows[trigger.endMessageIndex]?.seq ?? lastRow.seq,
      triggerKinds: trigger.triggerKinds,
      totalToolResults: episodeToolResults.length,
      failedToolResults: episodeToolResults.filter((entry) => entry.isError).length,
      events: episodeRows.map(renderEpisodeStudyEvent),
    };
  });
}

export function renderEpisodeStudyMarkdown(input: {
  title: string;
  windowStart: string;
  windowEnd: string;
  strategy: EpisodeStudyStrategyConfig;
  sessions: Array<{
    session: EpisodeStudySessionInfo;
    episodes: EpisodeStudyEpisode[];
  }>;
}): string {
  const lines: string[] = [
    `# ${input.title}`,
    "",
    `- Window start: ${input.windowStart}`,
    `- Window end: ${input.windowEnd}`,
    `- Strategy: ${input.strategy.id}`,
    `- Description: ${input.strategy.description}`,
    `- Trigger params: consecutive=${input.strategy.consecutiveFailuresThreshold ?? "off"}, density=${input.strategy.densityWindowSize ?? "off"} / ${input.strategy.densityFailureThreshold ?? "off"}, pre=${input.strategy.preContextMessages}, post=${input.strategy.postContextMessages}, maxEvents=${input.strategy.maxEventsPerEpisode}`,
    `- Time cap after trigger start: ${input.strategy.postContextMaxMinutes} minutes`,
    "",
  ];

  if (input.sessions.length === 0) {
    lines.push("_No sessions matched._");
    return lines.join("\n");
  }

  for (const entry of input.sessions) {
    lines.push(
      `## Session ${shortId(entry.session.sessionId)} (${entry.session.failedToolResultCount} failed tool results)`,
    );
    lines.push(
      `- Agent: ${entry.session.agentDisplayName ?? entry.session.ownerAgentId ?? "unknown"}`,
    );
    lines.push(`- Session id: ${entry.session.sessionId}`);
    lines.push("");

    if (entry.episodes.length === 0) {
      lines.push("_No episodes extracted for this strategy._");
      lines.push("");
      continue;
    }

    for (const episode of entry.episodes) {
      lines.push(
        `### ${episode.id} seq ${episode.startSeq}-${episode.endSeq} (trigger ${episode.triggerStartSeq}-${episode.triggerEndSeq})`,
      );
      lines.push(`- Trigger kinds: ${episode.triggerKinds.join(", ")}`);
      lines.push(`- Tool results: ${episode.failedToolResults}/${episode.totalToolResults} failed`);
      lines.push("");
      for (const event of episode.events) {
        lines.push(
          `- [${event.seq}] ${event.createdAt} ${event.role}/${event.messageType}: ${event.summary}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function collectParsedToolResults(rows: EpisodeStudyMessageRow[]): ParsedToolResultEntry[] {
  return rows.flatMap((row, messageIndex) => {
    if (row.messageType !== "tool_result") {
      return [];
    }
    const payload = parseJson<ParsedToolResultPayload>(row.payloadJson);
    if (payload == null) {
      return [];
    }
    return [
      {
        row,
        messageIndex,
        isError: payload.isError === true,
      },
    ];
  });
}

function isHarvestIgnoredToolResultRow(row: EpisodeStudyMessageRow): boolean {
  if (row.messageType !== "tool_result") {
    return false;
  }
  const payload = parseJson<ParsedToolResultPayload>(row.payloadJson);
  return payload?.details?.code === TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE;
}

function buildConsecutiveFailureTriggers(
  parsedToolResults: ParsedToolResultEntry[],
  strategy: EpisodeStudyStrategyConfig,
): TriggerRange[] {
  const threshold = strategy.consecutiveFailuresThreshold;
  if (threshold == null || threshold < 2) {
    return [];
  }

  const triggers: TriggerRange[] = [];
  let runStartIndex = -1;
  let runEndIndex = -1;
  let runLength = 0;

  const flush = () => {
    if (runLength >= threshold && runStartIndex >= 0 && runEndIndex >= 0) {
      triggers.push({
        startMessageIndex: runStartIndex,
        endMessageIndex: runEndIndex,
        triggerKinds: ["consecutive_failures"],
      });
    }
    runStartIndex = -1;
    runEndIndex = -1;
    runLength = 0;
  };

  for (const entry of parsedToolResults) {
    if (entry.isError) {
      if (runLength === 0) {
        runStartIndex = entry.messageIndex;
      }
      runEndIndex = entry.messageIndex;
      runLength += 1;
      continue;
    }
    flush();
  }

  flush();
  return triggers;
}

function buildDensityTriggers(
  parsedToolResults: ParsedToolResultEntry[],
  strategy: EpisodeStudyStrategyConfig,
): TriggerRange[] {
  const windowSize = strategy.densityWindowSize;
  const failureThreshold = strategy.densityFailureThreshold;
  if (windowSize == null || failureThreshold == null || windowSize <= 0 || failureThreshold <= 0) {
    return [];
  }

  const triggers: TriggerRange[] = [];
  for (let end = windowSize - 1; end < parsedToolResults.length; end += 1) {
    const start = end - windowSize + 1;
    const windowEntries = parsedToolResults.slice(start, end + 1);
    const failureCount = windowEntries.filter((entry) => entry.isError).length;
    if (failureCount < failureThreshold) {
      continue;
    }

    const failedEntries = windowEntries.filter((entry) => entry.isError);
    const first = failedEntries[0];
    const last = failedEntries.at(-1);
    if (first == null || last == null) {
      continue;
    }

    triggers.push({
      startMessageIndex: first.messageIndex,
      endMessageIndex: last.messageIndex,
      triggerKinds: ["failure_density"],
    });
  }

  return triggers;
}

function mergeTriggerRanges(triggers: TriggerRange[], mergeGapMessages: number): TriggerRange[] {
  const sorted = [...triggers].sort(
    (a, b) =>
      a.startMessageIndex - b.startMessageIndex ||
      a.endMessageIndex - b.endMessageIndex ||
      a.triggerKinds.join(",").localeCompare(b.triggerKinds.join(",")),
  );
  const merged: TriggerRange[] = [];

  for (const trigger of sorted) {
    const previous = merged.at(-1);
    if (
      previous != null &&
      trigger.startMessageIndex <= previous.endMessageIndex + Math.max(0, mergeGapMessages)
    ) {
      previous.endMessageIndex = Math.max(previous.endMessageIndex, trigger.endMessageIndex);
      previous.triggerKinds = dedupeStrings([...previous.triggerKinds, ...trigger.triggerKinds]);
      continue;
    }
    merged.push({
      startMessageIndex: trigger.startMessageIndex,
      endMessageIndex: trigger.endMessageIndex,
      triggerKinds: [...trigger.triggerKinds],
    });
  }

  return merged;
}

function renderEpisodeStudyEvent(row: EpisodeStudyMessageRow): EpisodeStudyRenderedEvent {
  return {
    seq: row.seq,
    createdAt: row.createdAt,
    role: row.role,
    messageType: row.messageType,
    summary: summarizeMeditationContextMessage(row),
  };
}

function parseJson<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shortId(input: string): string {
  return input.slice(0, 8);
}

function capEndIndexByElapsedMinutes(input: {
  rows: EpisodeStudyMessageRow[];
  startIndex: number;
  endIndex: number;
  maxMinutes: number;
}): number {
  const startRow = input.rows[input.startIndex];
  if (startRow == null || input.maxMinutes <= 0) {
    return input.endIndex;
  }

  const startAt = new Date(startRow.createdAt);
  if (Number.isNaN(startAt.getTime())) {
    return input.endIndex;
  }

  const maxMs = input.maxMinutes * 60 * 1000;
  let cappedEndIndex = input.endIndex;
  for (let index = input.startIndex; index <= input.endIndex; index += 1) {
    const row = input.rows[index];
    if (row == null) {
      break;
    }
    const rowAt = new Date(row.createdAt);
    if (Number.isNaN(rowAt.getTime())) {
      continue;
    }
    if (rowAt.getTime() - startAt.getTime() > maxMs) {
      cappedEndIndex = Math.max(input.startIndex, index - 1);
      break;
    }
  }

  return cappedEndIndex;
}
