import type {
  MeditationFailedToolResultFact,
  MeditationStopFact,
  MeditationTaskFailureFact,
} from "@/src/meditation/read-model.js";

const STOP_CLUSTER_WINDOW_MS = 15 * 60 * 1000;

export const SHARED_BUCKET_ID = "shared";

export type MeditationCluster =
  | StopCluster
  | TaskFailureCluster
  | ToolBurstCluster
  | ToolRepeatCluster;

export interface MeditationBucket {
  bucketId: string;
  agentId: string | null;
  score: number;
  preferredSessionIds: string[];
  clusters: MeditationCluster[];
}

interface ClusterBase {
  id: string;
  kind: "stop" | "task_failure" | "tool_burst" | "tool_repeat";
  bucketId: string;
  agentId: string | null;
  sessionIds: string[];
  startedAt: string;
  endedAt: string;
}

export interface StopCluster extends ClusterBase {
  kind: "stop";
  stopCount: number;
  facts: MeditationStopFact[];
}

export interface TaskFailureCluster extends ClusterBase {
  kind: "task_failure";
  taskRunId: string;
  status: string;
  fact: MeditationTaskFailureFact;
}

export interface ToolBurstCluster extends ClusterBase {
  kind: "tool_burst";
  sessionId: string;
  startSeq: number;
  endSeq: number;
  count: number;
  signatures: string[];
  facts: Array<MeditationFailedToolResultFact & { signature: string }>;
}

export interface ToolRepeatCluster extends ClusterBase {
  kind: "tool_repeat";
  signature: string;
  count: number;
  facts: Array<MeditationFailedToolResultFact & { signature: string }>;
}

export interface BuildMeditationClustersInput {
  stops: MeditationStopFact[];
  taskFailures: MeditationTaskFailureFact[];
  failedToolResults: MeditationFailedToolResultFact[];
}

export function buildMeditationBuckets(input: BuildMeditationClustersInput): MeditationBucket[] {
  const clusters = [
    ...buildStopClusters(input.stops),
    ...buildTaskFailureClusters(input.taskFailures),
    ...buildToolBurstClusters(input.failedToolResults),
    ...buildToolRepeatClusters(input.failedToolResults),
  ];

  const buckets = new Map<string, MeditationBucket>();
  for (const cluster of clusters) {
    const existing = buckets.get(cluster.bucketId);
    if (existing == null) {
      buckets.set(cluster.bucketId, {
        bucketId: cluster.bucketId,
        agentId: cluster.agentId,
        score: scoreCluster(cluster),
        preferredSessionIds: dedupeStrings(cluster.sessionIds),
        clusters: [cluster],
      });
      continue;
    }

    existing.score += scoreCluster(cluster);
    existing.clusters.push(cluster);
    existing.preferredSessionIds = dedupeStrings([
      ...existing.preferredSessionIds,
      ...cluster.sessionIds,
    ]);
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      ...bucket,
      clusters: [...bucket.clusters].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    }))
    .sort((a, b) => b.score - a.score || a.bucketId.localeCompare(b.bucketId));
}

export function buildFailureSignature(fact: MeditationFailedToolResultFact): string {
  return [
    fact.toolName,
    fact.detailsCode ?? "",
    fact.requestScopeKind ?? "",
    fact.requestPrefix0 ?? "",
    normalizeContentPrefix(fact.contentText),
  ].join("|");
}

function buildStopClusters(facts: MeditationStopFact[]): StopCluster[] {
  const sorted = [...facts].sort(
    (a, b) =>
      bucketIdForAgent(a.agentId).localeCompare(bucketIdForAgent(b.agentId)) ||
      (a.sessionId ?? "").localeCompare(b.sessionId ?? "") ||
      a.createdAt.localeCompare(b.createdAt),
  );
  const clusters: StopCluster[] = [];

  for (const fact of sorted) {
    const bucketId = bucketIdForAgent(fact.agentId);
    const previous = clusters.at(-1);
    if (
      previous != null &&
      previous.bucketId === bucketId &&
      previous.sessionIds[0] === (fact.sessionId ?? "") &&
      isWithinStopClusterWindow(previous.endedAt, fact.createdAt)
    ) {
      previous.facts.push(fact);
      previous.stopCount += 1;
      previous.endedAt = fact.createdAt;
      continue;
    }

    clusters.push({
      id: `stop:${bucketId}:${fact.sessionId ?? "no-session"}:${clusters.length + 1}`,
      kind: "stop",
      bucketId,
      agentId: fact.agentId,
      sessionIds: fact.sessionId == null ? [] : [fact.sessionId],
      startedAt: fact.createdAt,
      endedAt: fact.createdAt,
      stopCount: 1,
      facts: [fact],
    });
  }

  return clusters;
}

function buildTaskFailureClusters(facts: MeditationTaskFailureFact[]): TaskFailureCluster[] {
  return facts.map((fact) => ({
    id: `task:${fact.id}`,
    kind: "task_failure",
    bucketId: bucketIdForAgent(fact.ownerAgentId),
    agentId: fact.ownerAgentId,
    sessionIds: fact.executionSessionId == null ? [] : [fact.executionSessionId],
    startedAt: fact.startedAt,
    endedAt: fact.finishedAt ?? fact.startedAt,
    taskRunId: fact.id,
    status: fact.status,
    fact,
  }));
}

function buildToolBurstClusters(facts: MeditationFailedToolResultFact[]): ToolBurstCluster[] {
  const sorted = [...facts]
    .map((fact) => ({ ...fact, signature: buildFailureSignature(fact) }))
    .sort(
      (a, b) =>
        bucketIdForAgent(a.ownerAgentId).localeCompare(bucketIdForAgent(b.ownerAgentId)) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.seq - b.seq,
    );

  const clusters: ToolBurstCluster[] = [];
  let active: Array<MeditationFailedToolResultFact & { signature: string }> = [];

  const flush = () => {
    if (active.length < 2) {
      active = [];
      return;
    }

    const first = active[0];
    const last = active[active.length - 1];
    if (first == null || last == null) {
      active = [];
      return;
    }
    clusters.push({
      id: `tool-burst:${bucketIdForAgent(first.ownerAgentId)}:${first.sessionId}:${first.seq}-${last.seq}`,
      kind: "tool_burst",
      bucketId: bucketIdForAgent(first.ownerAgentId),
      agentId: first.ownerAgentId,
      sessionIds: [first.sessionId],
      startedAt: first.createdAt,
      endedAt: last.createdAt,
      sessionId: first.sessionId,
      startSeq: first.seq,
      endSeq: last.seq,
      count: active.length,
      signatures: dedupeStrings(active.map((entry) => entry.signature)),
      facts: active,
    });
    active = [];
  };

  for (const fact of sorted) {
    const previous = active.at(-1);
    if (
      previous != null &&
      previous.ownerAgentId === fact.ownerAgentId &&
      previous.sessionId === fact.sessionId &&
      fact.seq === previous.seq + 1
    ) {
      active.push(fact);
      continue;
    }

    flush();
    active = [fact];
  }

  flush();
  return clusters;
}

function buildToolRepeatClusters(facts: MeditationFailedToolResultFact[]): ToolRepeatCluster[] {
  const grouped = new Map<string, Array<MeditationFailedToolResultFact & { signature: string }>>();
  for (const fact of facts) {
    const enriched = { ...fact, signature: buildFailureSignature(fact) };
    const groupKey = `${bucketIdForAgent(fact.ownerAgentId)}::${enriched.signature}`;
    const existing = grouped.get(groupKey);
    if (existing == null) {
      grouped.set(groupKey, [enriched]);
    } else {
      existing.push(enriched);
    }
  }

  const clusters: ToolRepeatCluster[] = [];
  for (const [groupKey, group] of grouped) {
    if (group.length < 2) {
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first == null || last == null) {
      continue;
    }
    const [bucketId = SHARED_BUCKET_ID] = groupKey.split("::");
    clusters.push({
      id: `tool-repeat:${bucketId}:${first.signature}`,
      kind: "tool_repeat",
      bucketId,
      agentId: first.ownerAgentId,
      sessionIds: dedupeStrings(sorted.map((entry) => entry.sessionId)),
      startedAt: first.createdAt,
      endedAt: last.createdAt,
      signature: first.signature,
      count: sorted.length,
      facts: sorted,
    });
  }

  return clusters.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function bucketIdForAgent(agentId: string | null): string {
  return agentId ?? SHARED_BUCKET_ID;
}

function isWithinStopClusterWindow(previousIso: string, currentIso: string): boolean {
  const previous = new Date(previousIso);
  const current = new Date(currentIso);
  if (Number.isNaN(previous.getTime()) || Number.isNaN(current.getTime())) {
    return false;
  }
  return current.getTime() - previous.getTime() <= STOP_CLUSTER_WINDOW_MS;
}

function scoreCluster(cluster: MeditationCluster): number {
  switch (cluster.kind) {
    case "stop":
      return 50;
    case "task_failure":
      return 30;
    case "tool_repeat":
      return 20;
    case "tool_burst":
      return 15;
  }
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function normalizeContentPrefix(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 80).toLowerCase();
}
