import type {
  MeditationBucket,
  StopCluster,
  TaskFailureCluster,
  ToolBurstCluster,
  ToolRepeatCluster,
} from "@/src/meditation/clustering.js";
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
  contextMessages: MeditationMessageWindowEntry[];
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
  const contextMessages = readModel.listSessionMessageWindow(
    cluster.sessionId,
    cluster.endSeq,
    cluster.endSeq - cluster.startSeq + TOOL_CONTEXT_BEFORE,
    TOOL_CONTEXT_AFTER,
  );

  return {
    id: cluster.id,
    kind: cluster.kind,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    count: cluster.count,
    signatures: cluster.signatures,
    contextMessages,
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

  return {
    id: cluster.id,
    kind: cluster.kind,
    startedAt: cluster.startedAt,
    endedAt: cluster.endedAt,
    signature: cluster.signature,
    count: cluster.count,
    examples,
  };
}
