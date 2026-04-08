import os from "node:os";
import path from "node:path";
import process from "node:process";

import Database from "better-sqlite3";

type MessageRow = {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  messageType: string;
  createdAt: string;
  payloadJson: string;
};

type ToolResultPayload = {
  toolName?: unknown;
  isError?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
  details?: unknown;
};

type ParsedToolFailure = {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  toolName: string;
  signature: string;
  bucket: string;
  text: string;
};

type FailureStreak = {
  sessionId: string;
  startSeq: number;
  endSeq: number;
  count: number;
  signatures: string[];
};

type TurnFailureCluster = {
  sessionId: string;
  assistantSeq: number;
  startSeq: number;
  endSeq: number;
  totalToolResults: number;
  failedToolResults: number;
  failureRate: number;
  signatures: string[];
};

type ThresholdReport<T> = {
  thresholdLabel: string;
  matched: T[];
};

const DEFAULT_DB_PATH = path.join(os.homedir(), ".pokeclaw", "system", "pokeclaw.db");
const SAMPLE_LIMIT = 8;

function main(): void {
  const dbPath = process.argv[2] ?? DEFAULT_DB_PATH;
  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .prepare(
      `
        SELECT id, session_id as sessionId, seq, role, message_type as messageType, created_at as createdAt, payload_json as payloadJson
        FROM messages
        ORDER BY session_id ASC, seq ASC
      `,
    )
    .all() as MessageRow[];

  const totalToolResults = rows.filter((row) => row.messageType === "tool_result").length;
  const parsedFailures = rows.flatMap((row) => parseToolFailure(row));

  const streaks = collectFailureStreaks(rows);
  const turns = collectTurnFailureClusters(rows);

  const codeCoverage = computeClassificationCoverage(parsedFailures);

  printHeader(dbPath, rows.length, totalToolResults, parsedFailures.length, codeCoverage);
  printTopBuckets(parsedFailures);
  printTopSignatures(parsedFailures);

  const streakReports: Array<ThresholdReport<FailureStreak>> = [
    {
      thresholdLabel: "consecutive failures >= 2",
      matched: streaks.filter((entry) => entry.count >= 2),
    },
    {
      thresholdLabel: "consecutive failures >= 3",
      matched: streaks.filter((entry) => entry.count >= 3),
    },
  ];
  for (const report of streakReports) {
    printStreakReport(report);
  }

  const turnReports: Array<ThresholdReport<TurnFailureCluster>> = [
    {
      thresholdLabel: "turn failedToolResults > 2",
      matched: turns.filter((entry) => entry.failedToolResults > 2),
    },
    {
      thresholdLabel: "turn failedToolResults > 3",
      matched: turns.filter((entry) => entry.failedToolResults > 3),
    },
    {
      thresholdLabel: "turn failedToolResults > 4",
      matched: turns.filter((entry) => entry.failedToolResults > 4),
    },
    {
      thresholdLabel: "turn failedToolResults > 5",
      matched: turns.filter((entry) => entry.failedToolResults > 5),
    },
  ];
  for (const report of turnReports) {
    printTurnReport(report);
  }
}

function parseToolFailure(row: MessageRow): ParsedToolFailure[] {
  if (row.messageType !== "tool_result") {
    return [];
  }

  const payload = parseJson<ToolResultPayload>(row.payloadJson);
  if (!payload || payload.isError !== true) {
    return [];
  }

  const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
  const text = normalizeFailureText(payload.content);
  const { signature, bucket } = classifyFailure(toolName, payload.details, text);

  return [
    {
      id: row.id,
      sessionId: row.sessionId,
      seq: row.seq,
      createdAt: row.createdAt,
      toolName,
      signature,
      bucket,
      text,
    },
  ];
}

function collectFailureStreaks(rows: MessageRow[]): FailureStreak[] {
  const streaks: FailureStreak[] = [];
  let currentSessionId: string | null = null;
  let activeFailures: ParsedToolFailure[] = [];

  const flush = () => {
    if (activeFailures.length === 0) {
      return;
    }
    const first = activeFailures[0];
    const last = activeFailures[activeFailures.length - 1];
    if (first == null || last == null) {
      activeFailures = [];
      return;
    }
    streaks.push({
      sessionId: first.sessionId,
      startSeq: first.seq,
      endSeq: last.seq,
      count: activeFailures.length,
      signatures: uniqueStrings(
        activeFailures.map((entry) => entry.signature),
        6,
      ),
    });
    activeFailures = [];
  };

  for (const row of rows) {
    if (currentSessionId !== row.sessionId) {
      flush();
      currentSessionId = row.sessionId;
    }

    if (row.messageType !== "tool_result") {
      flush();
      continue;
    }

    const failures = parseToolFailure(row);
    const firstFailure = failures[0];
    if (firstFailure == null) {
      flush();
      continue;
    }

    activeFailures.push(firstFailure);
  }

  flush();
  return streaks.sort((a, b) => b.count - a.count || a.sessionId.localeCompare(b.sessionId));
}

function collectTurnFailureClusters(rows: MessageRow[]): TurnFailureCluster[] {
  const turns: TurnFailureCluster[] = [];
  let currentSessionId: string | null = null;
  let currentAssistantSeq: number | null = null;
  let currentToolResults: ParsedToolFailure[] = [];
  let currentToolResultTotal = 0;

  const flush = () => {
    if (currentAssistantSeq == null || currentToolResultTotal === 0) {
      currentToolResults = [];
      currentToolResultTotal = 0;
      return;
    }

    const failedToolResults = currentToolResults.length;
    const startSeq = currentToolResults[0]?.seq ?? currentAssistantSeq;
    const endSeq = currentToolResults.at(-1)?.seq ?? currentAssistantSeq;
    turns.push({
      sessionId: currentSessionId ?? "unknown",
      assistantSeq: currentAssistantSeq,
      startSeq,
      endSeq,
      totalToolResults: currentToolResultTotal,
      failedToolResults,
      failureRate: currentToolResultTotal === 0 ? 0 : failedToolResults / currentToolResultTotal,
      signatures: uniqueStrings(
        currentToolResults.map((entry) => entry.signature),
        8,
      ),
    });

    currentToolResults = [];
    currentToolResultTotal = 0;
  };

  for (const row of rows) {
    if (currentSessionId !== row.sessionId) {
      flush();
      currentSessionId = row.sessionId;
      currentAssistantSeq = null;
    }

    if (row.role === "assistant") {
      flush();
      currentAssistantSeq = row.seq;
      continue;
    }

    if (row.messageType !== "tool_result") {
      continue;
    }

    if (currentAssistantSeq == null) {
      continue;
    }

    currentToolResultTotal += 1;
    const failures = parseToolFailure(row);
    const firstFailure = failures[0];
    if (firstFailure != null) {
      currentToolResults.push(firstFailure);
    }
  }

  flush();
  return turns.sort(
    (a, b) =>
      b.failedToolResults - a.failedToolResults ||
      b.failureRate - a.failureRate ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

function classifyFailure(
  toolName: string,
  details: unknown,
  text: string,
): {
  signature: string;
  bucket: string;
} {
  const detailsRecord = asRecord(details);
  const code = typeof detailsRecord?.code === "string" ? detailsRecord.code : null;
  if (code) {
    return {
      signature: `${toolName}:${code}`,
      bucket: bucketFromCode(code),
    };
  }

  const request = asRecord(detailsRecord?.request);
  const firstScope = Array.isArray(request?.scopes) ? asRecord(request.scopes[0]) : null;
  const scopeKind = typeof firstScope?.kind === "string" ? firstScope.kind : null;
  const prefix0 =
    Array.isArray(firstScope?.prefix) && typeof firstScope.prefix[0] === "string"
      ? firstScope.prefix[0]
      : null;

  if (scopeKind === "bash.full_access") {
    if (text.includes("Permission request denied")) {
      return {
        signature: `bash:approval_denied:${prefix0 ?? "unknown"}`,
        bucket: "permission_bash",
      };
    }
    if (text.toLowerCase().includes("overbroad bash -lc")) {
      return {
        signature: "bash:overbroad_bash_lc",
        bucket: "permission_bash",
      };
    }
    if (text.toLowerCase().includes("timed out")) {
      return {
        signature: "bash:approval_timeout",
        bucket: "permission_bash",
      };
    }
    return {
      signature: `bash:approval_related:${prefix0 ?? "unknown"}`,
      bucket: "permission_bash",
    };
  }

  if (toolName === "request_permissions") {
    return {
      signature: "request_permissions:denied_or_unresolved",
      bucket: "permission_request",
    };
  }

  if (text.includes("Permission request denied")) {
    return {
      signature: `${toolName}:permission_request_denied`,
      bucket: "permission_other",
    };
  }

  return {
    signature: `${toolName}:unclassified`,
    bucket: "unclassified",
  };
}

function bucketFromCode(code: string): string {
  if (code === "permission_denied") {
    return "permission_fs";
  }
  if (code === "invalid_tool_args") {
    return "invalid_args";
  }
  if (code.includes("timeout")) {
    return "timeout";
  }
  if (code.includes("not_found") || code === "path_not_found" || code === "file_not_found") {
    return "missing_target";
  }
  if (code === "web_fetch_failed") {
    return "network_or_remote";
  }
  if (code === "old_text_not_found" || code === "multiple_matches" || code === "no_changes") {
    return "edit_mismatch";
  }
  if (code.startsWith("bash_full_access")) {
    return "permission_bash";
  }
  return "other_code";
}

function normalizeFailureText(content: ToolResultPayload["content"]): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function computeClassificationCoverage(failures: ParsedToolFailure[]): {
  classified: number;
  unclassified: number;
  classifiedPct: number;
} {
  const unclassified = failures.filter((entry) => entry.bucket === "unclassified").length;
  const classified = failures.length - unclassified;
  return {
    classified,
    unclassified,
    classifiedPct: failures.length === 0 ? 0 : (classified / failures.length) * 100,
  };
}

function printHeader(
  dbPath: string,
  totalMessages: number,
  totalToolResults: number,
  totalFailures: number,
  coverage: {
    classified: number;
    unclassified: number;
    classifiedPct: number;
  },
): void {
  console.log(`DB: ${dbPath}`);
  console.log(`messages: ${totalMessages}`);
  console.log(`tool_result: ${totalToolResults}`);
  console.log(
    `failed tool_result: ${totalFailures} (${formatPct(totalFailures, totalToolResults)})`,
  );
  console.log(
    `classified failures: ${coverage.classified}/${totalFailures} (${coverage.classifiedPct.toFixed(1)}%), unclassified: ${coverage.unclassified}`,
  );
  console.log("");
}

function printTopBuckets(failures: ParsedToolFailure[]): void {
  console.log("Top buckets");
  for (const [bucket, count] of aggregateCounts(failures.map((entry) => entry.bucket)).slice(
    0,
    12,
  )) {
    console.log(`- ${bucket}: ${count}`);
  }
  console.log("");
}

function printTopSignatures(failures: ParsedToolFailure[]): void {
  console.log("Top signatures");
  for (const [signature, count] of aggregateCounts(failures.map((entry) => entry.signature)).slice(
    0,
    16,
  )) {
    console.log(`- ${signature}: ${count}`);
  }
  console.log("");
}

function printStreakReport(report: ThresholdReport<FailureStreak>): void {
  console.log(`${report.thresholdLabel}: ${report.matched.length} matches`);
  for (const entry of report.matched.slice(0, SAMPLE_LIMIT)) {
    console.log(
      `- session=${shortId(entry.sessionId)} seq=${entry.startSeq}-${entry.endSeq} count=${entry.count} signatures=${entry.signatures.join(", ")}`,
    );
  }
  console.log("");
}

function printTurnReport(report: ThresholdReport<TurnFailureCluster>): void {
  console.log(`${report.thresholdLabel}: ${report.matched.length} matches`);
  for (const entry of report.matched.slice(0, SAMPLE_LIMIT)) {
    console.log(
      `- session=${shortId(entry.sessionId)} assistantSeq=${entry.assistantSeq} toolSeq=${entry.startSeq}-${entry.endSeq} failed=${entry.failedToolResults}/${entry.totalToolResults} failureRate=${(entry.failureRate * 100).toFixed(0)}% signatures=${entry.signatures.join(", ")}`,
    );
  }
  console.log("");
}

function aggregateCounts(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function uniqueStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
    if (unique.length >= limit) {
      break;
    }
  }
  return unique;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatPct(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "0.0%";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

main();
