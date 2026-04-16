import type {
  MeditationBucket,
  StopCluster,
  TaskFailureCluster,
  ToolBurstCluster,
  ToolRepeatCluster,
} from "@/src/meditation/clustering.js";
import {
  DEFAULT_MEDITATION_EPISODE_EXTRACTION_STRATEGY,
  type EpisodeStudyMessageRow,
  extractEpisodeStudyEpisodes,
} from "@/src/meditation/episode-study.js";
import type {
  MeditationBucketProfile,
  MeditationMessageWindowEntry,
  MeditationReadModel,
} from "@/src/meditation/read-model.js";

const STOP_CONTEXT_BEFORE = 1;
const STOP_CONTEXT_AFTER = 1;
const TASK_CONTEXT_BEFORE = 1;
const TASK_CONTEXT_AFTER = 1;
const TOOL_CONTEXT_BEFORE = 1;
const TOOL_CONTEXT_AFTER = 1;
const MAX_REPEAT_EXAMPLES = 2;
const MAX_REPEAT_EPISODES = 2;

export interface PreparedMeditationBucket {
  bucketId: string;
  agentId: string | null;
  score: number;
  preferredSessionIds: string[];
  profile: MeditationBucketProfile | null;
  clusters: PreparedMeditationCluster[];
}

export type PreparedMeditationCluster =
  | PreparedStopCluster
  | PreparedTaskFailureCluster
  | PreparedToolBurstCluster
  | PreparedToolRepeatCluster;

interface PreparedClusterBase {
  id: string;
  kind: "stop" | "task_failure" | "tool_burst" | "tool_repeat";
  startedAt: string;
  endedAt: string;
}

export interface PreparedStopCluster extends PreparedClusterBase {
  kind: "stop";
  stopCount: number;
  contextMessages: MeditationMessageWindowEntry[];
}

export interface PreparedTaskFailureCluster extends PreparedClusterBase {
  kind: "task_failure";
  taskRunId: string;
  status: string;
  description: string | null;
  resultSummary: string | null;
  errorText: string | null;
  contextMessages: MeditationMessageWindowEntry[];
}

export interface PreparedToolBurstCluster extends PreparedClusterBase {
  kind: "tool_burst";
  count: number;
  signatures: string[];
  episodeTimeline: PreparedEpisodeTimeline | null;
}

export interface PreparedToolRepeatExample {
  factId: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  messageWindow: MeditationMessageWindowEntry[];
}

export interface PreparedToolRepeatCluster extends PreparedClusterBase {
  kind: "tool_repeat";
  signature: string;
  count: number;
  examples: PreparedToolRepeatExample[];
  episodes: PreparedEpisodeTimeline[];
}

export interface PreparedEpisodeTimelineEvent {
  seq: number;
  createdAt: string;
  role: string;
  messageType: string;
  summary: string;
}

export interface PreparedEpisodeTimeline {
  id: string;
  sessionId: string;
  startSeq: number;
  endSeq: number;
  triggerStartSeq: number;
  triggerEndSeq: number;
  triggerKinds: string[];
  totalToolResults: number;
  failedToolResults: number;
  events: PreparedEpisodeTimelineEvent[];
}

export interface PrepareMeditationBucketInputInput {
  bucket: MeditationBucket;
  readModel: MeditationReadModel;
}

export function prepareMeditationBucketInput(
  input: PrepareMeditationBucketInputInput,
): PreparedMeditationBucket {
  return {
    bucketId: input.bucket.bucketId,
    agentId: input.bucket.agentId,
    score: input.bucket.score,
    preferredSessionIds: input.bucket.preferredSessionIds,
    profile:
      input.bucket.agentId == null
        ? null
        : input.readModel.resolveBucketProfile(
            input.bucket.agentId,
            input.bucket.preferredSessionIds,
          ),
    clusters: input.bucket.clusters.map((cluster) => prepareCluster(cluster, input.readModel)),
  };
}

function prepareCluster(
  cluster: MeditationBucket["clusters"][number],
  readModel: MeditationReadModel,
): PreparedMeditationCluster {
  switch (cluster.kind) {
    case "stop":
      return prepareStopCluster(cluster, readModel);
    case "task_failure":
      return prepareTaskFailureCluster(cluster, readModel);
    case "tool_burst":
      return prepareToolBurstCluster(cluster, readModel);
    case "tool_repeat":
      return prepareToolRepeatCluster(cluster, readModel);
  }
}

function prepareStopCluster(
  cluster: StopCluster,
  readModel: MeditationReadModel,
): PreparedStopCluster {
  const anchor = cluster.facts.at(-1) ?? cluster.facts[0];
  const contextMessages =
    anchor?.sessionId == null
      ? []
      : readModel.listSessionMessageWindowByTime(
          anchor.sessionId,
          anchor.createdAt,
          STOP_CONTEXT_BEFORE,
          STOP_CONTEXT_AFTER,
        );

  return {
    id: cluster.id,
    kind: cluster.kind,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    stopCount: cluster.stopCount,
    contextMessages,
  };
}

function prepareTaskFailureCluster(
  cluster: TaskFailureCluster,
  readModel: MeditationReadModel,
): PreparedTaskFailureCluster {
  const anchor = cluster.fact.finishedAt ?? cluster.fact.startedAt;
  const contextMessages =
    cluster.fact.executionSessionId == null
      ? []
      : readModel.listSessionMessageWindowByTime(
          cluster.fact.executionSessionId,
          anchor,
          TASK_CONTEXT_BEFORE,
          TASK_CONTEXT_AFTER,
        );

  return {
    id: cluster.id,
    kind: cluster.kind,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    taskRunId: cluster.taskRunId,
    status: cluster.status,
    description: cluster.fact.description,
    resultSummary: cluster.fact.resultSummary,
    errorText: cluster.fact.errorText,
    contextMessages,
  };
}

function prepareToolBurstCluster(
  cluster: ToolBurstCluster,
  readModel: MeditationReadModel,
): PreparedToolBurstCluster {
  const sessionMessages = readModel.listSessionMessages(cluster.sessionId);
  const episodeTimeline =
    selectRelevantEpisodes(
      toEpisodeStudyRows(sessionMessages),
      cluster.facts.map((fact) => fact.seq),
    )[0] ?? null;

  return {
    id: cluster.id,
    kind: cluster.kind,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    count: cluster.count,
    signatures: cluster.signatures,
    episodeTimeline,
  };
}

function prepareToolRepeatCluster(
  cluster: ToolRepeatCluster,
  readModel: MeditationReadModel,
): PreparedToolRepeatCluster {
  const examples = cluster.facts.slice(0, MAX_REPEAT_EXAMPLES).map((fact) => ({
    factId: fact.id,
    sessionId: fact.sessionId,
    seq: fact.seq,
    createdAt: fact.createdAt,
    messageWindow: readModel.listSessionMessageWindow(
      fact.sessionId,
      fact.seq,
      TOOL_CONTEXT_BEFORE,
      TOOL_CONTEXT_AFTER,
    ),
  }));
  const episodes = Array.from(new Set(cluster.facts.map((fact) => fact.sessionId)))
    .flatMap((sessionId) => {
      const sessionFacts = cluster.facts.filter((fact) => fact.sessionId === sessionId);
      const sessionMessages = readModel.listSessionMessages(sessionId);
      return selectRelevantEpisodes(
        toEpisodeStudyRows(sessionMessages),
        sessionFacts.map((fact) => fact.seq),
      );
    })
    .slice(0, MAX_REPEAT_EPISODES);

  return {
    id: cluster.id,
    kind: cluster.kind,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    signature: cluster.signature,
    count: cluster.count,
    examples,
    episodes,
  };
}

function toEpisodeStudyRows(entries: MeditationMessageWindowEntry[]): EpisodeStudyMessageRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    sessionId: entry.sessionId,
    seq: entry.seq,
    role: entry.role,
    messageType: entry.messageType,
    visibility: entry.visibility,
    createdAt: entry.createdAt,
    payloadJson: entry.payloadJson,
  }));
}

function selectRelevantEpisodes(
  rows: EpisodeStudyMessageRow[],
  relevantSeqs: number[],
): PreparedEpisodeTimeline[] {
  const relevantSeqSet = new Set(relevantSeqs);
  return extractEpisodeStudyEpisodes(rows, DEFAULT_MEDITATION_EPISODE_EXTRACTION_STRATEGY)
    .filter(
      (episode) =>
        episode.events.some((event) => relevantSeqSet.has(event.seq)) ||
        relevantSeqs.some((seq) => seq >= episode.triggerStartSeq && seq <= episode.triggerEndSeq),
    )
    .map((episode) => ({
      id: episode.id,
      sessionId: episode.sessionId,
      startSeq: episode.startSeq,
      endSeq: episode.endSeq,
      triggerStartSeq: episode.triggerStartSeq,
      triggerEndSeq: episode.triggerEndSeq,
      triggerKinds: episode.triggerKinds,
      totalToolResults: episode.totalToolResults,
      failedToolResults: episode.failedToolResults,
      events: episode.events.map((event) => ({
        seq: event.seq,
        createdAt: event.createdAt,
        role: event.role,
        messageType: event.messageType,
        summary: event.summary,
      })),
    }));
}
