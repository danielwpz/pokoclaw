/**
 * Meditation episode study CLI.
 *
 * Purpose:
 * - pull real historical session data from the SQLite runtime database
 * - apply multiple candidate friction-episode extraction strategies
 * - write readable reports under `.tmp/meditation-episode-study/<label>/`
 * - help humans compare which extraction shape gives meditation the best
 *   "failure -> later context" fragments before changing production logic
 *
 * This script is read-only against the source database.
 *
 * Usage:
 *   pnpm meditation:episode-study -- --tick-at 2026-04-15T12:30:00.000Z --lookback-days 7
 *
 *   pnpm meditation:episode-study -- \
 *     --tick-at 2026-04-15T12:30:00.000Z \
 *     --start-at 2026-04-14T00:00:00.000Z \
 *     --end-at 2026-04-15T00:00:00.000Z \
 *     --top-sessions 4 \
 *     --label latest-window
 *
 *   pnpm meditation:episode-study -- \
 *     --tick-at 2026-04-15T12:30:00.000Z \
 *     --session-id d66693fd-0000-0000-0000-000000000000 \
 *     --session-id 7d3e814c-0000-0000-0000-000000000000
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import {
  buildMeditationBacktestWindow,
  sanitizeMeditationBacktestLabel,
} from "@/src/meditation/backtest.js";
import {
  DEFAULT_EPISODE_STUDY_STRATEGIES,
  type EpisodeStudyMessageRow,
  type EpisodeStudySessionInfo,
  extractEpisodeStudyEpisodes,
  renderEpisodeStudyMarkdown,
} from "@/src/meditation/episode-study.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { resolveLocalCalendarContext, toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import { TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE } from "@/src/shared/tool-result-codes.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";

const logger = createSubsystemLogger("script/meditation-episode-study");

interface EpisodeStudyArgs {
  tickAt: Date;
  startAt?: Date;
  endAt?: Date;
  lastSuccessAt?: string | null;
  lookbackDays?: number;
  label: string;
  topSessions: number;
  dbPath: string;
  sessionIds: string[];
}

type SessionMessageRow = EpisodeStudyMessageRow;

type SessionCountRow = EpisodeStudySessionInfo;

const DEFAULT_LABEL = "latest";
const DEFAULT_TOP_SESSIONS = 4;

export function parseMeditationEpisodeStudyArgs(argv: string[]): EpisodeStudyArgs {
  const normalizedArgv = argv.filter((arg) => arg !== "--");
  let tickAt: Date | undefined;
  let startAt: Date | undefined;
  let endAt: Date | undefined;
  let lastSuccessAt: string | null | undefined;
  let lookbackDays: number | undefined;
  let label = DEFAULT_LABEL;
  let topSessions = DEFAULT_TOP_SESSIONS;
  let dbPath = getProductionDatabasePath();
  const sessionIds: string[] = [];

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const arg = normalizedArgv[index];
    if (arg == null) {
      continue;
    }

    const next = normalizedArgv[index + 1];
    switch (arg) {
      case "--tick-at":
        tickAt = parseRequiredDate(arg, next);
        index += 1;
        break;
      case "--start-at":
        startAt = parseRequiredDate(arg, next);
        index += 1;
        break;
      case "--end-at":
        endAt = parseRequiredDate(arg, next);
        index += 1;
        break;
      case "--last-success-at":
        if (next == null) {
          throw new Error(`${arg} requires a value`);
        }
        lastSuccessAt = next === "null" ? null : next;
        index += 1;
        break;
      case "--lookback-days":
        if (next == null) {
          throw new Error(`${arg} requires a value`);
        }
        lookbackDays = parsePositiveInteger(arg, next);
        index += 1;
        break;
      case "--label":
        if (next == null) {
          throw new Error(`${arg} requires a value`);
        }
        label = sanitizeMeditationBacktestLabel(next) || DEFAULT_LABEL;
        index += 1;
        break;
      case "--top-sessions":
        if (next == null) {
          throw new Error(`${arg} requires a value`);
        }
        topSessions = parsePositiveInteger(arg, next);
        index += 1;
        break;
      case "--db-path":
        if (next == null) {
          throw new Error(`${arg} requires a value`);
        }
        dbPath = path.resolve(next);
        index += 1;
        break;
      case "--session-id":
        if (next == null) {
          throw new Error(`${arg} requires a value`);
        }
        sessionIds.push(next);
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const result: EpisodeStudyArgs = {
    tickAt: tickAt ?? new Date(),
    label,
    topSessions,
    dbPath,
    sessionIds,
  };
  if (startAt !== undefined) {
    result.startAt = startAt;
  }
  if (endAt !== undefined) {
    result.endAt = endAt;
  }
  if (lastSuccessAt !== undefined) {
    result.lastSuccessAt = lastSuccessAt;
  }
  if (lookbackDays !== undefined) {
    result.lookbackDays = lookbackDays;
  }
  return result;
}

export async function runMeditationEpisodeStudy(args: EpisodeStudyArgs): Promise<void> {
  const calendarContext = resolveLocalCalendarContext(args.tickAt);
  const window = buildMeditationBacktestWindow({
    tickAt: args.tickAt,
    calendarContext,
    ...(args.startAt !== undefined ? { startAt: args.startAt } : {}),
    ...(args.endAt !== undefined ? { endAt: args.endAt } : {}),
    ...(args.lastSuccessAt !== undefined ? { lastSuccessAt: args.lastSuccessAt } : {}),
    ...(args.lookbackDays !== undefined ? { lookbackDays: args.lookbackDays } : {}),
  });

  const outputRoot = path.join(process.cwd(), ".tmp", "meditation-episode-study", args.label);
  await mkdir(outputRoot, { recursive: true });

  const db = new Database(args.dbPath, { readonly: true });
  try {
    const sessions = resolveStudySessions({
      db,
      windowStart: window.startAt,
      windowEnd: window.endAt,
      requestedSessionIds: args.sessionIds,
      topSessions: args.topSessions,
    });

    const overviewLines = [
      `label=${args.label}`,
      `db=${args.dbPath}`,
      `windowStart=${window.startAt}`,
      `windowEnd=${window.endAt}`,
      `lookbackClipped=${window.clippedByLookback ? "yes" : "no"}`,
      `sessions=${sessions.length}`,
      ...sessions.map(
        (session) =>
          `session=${session.sessionId} failedToolResults=${session.failedToolResultCount} agent=${session.agentDisplayName ?? session.ownerAgentId ?? "unknown"}`,
      ),
      "",
    ];

    for (const strategy of DEFAULT_EPISODE_STUDY_STRATEGIES) {
      const sessionReports = sessions.map((session) => {
        const rows = loadSessionMessages({
          db,
          sessionId: session.sessionId,
          windowStart: window.startAt,
          windowEnd: window.endAt,
        });
        return {
          session,
          episodes: extractEpisodeStudyEpisodes(rows, strategy),
        };
      });

      const reportMarkdown = renderEpisodeStudyMarkdown({
        title: `Meditation Episode Study: ${strategy.id}`,
        windowStart: window.startAt,
        windowEnd: window.endAt,
        strategy,
        sessions: sessionReports,
      });

      const markdownPath = path.join(outputRoot, `${strategy.id}.md`);
      const jsonPath = path.join(outputRoot, `${strategy.id}.json`);
      await writeFile(markdownPath, reportMarkdown, "utf8");
      await writeFile(
        jsonPath,
        JSON.stringify(
          {
            generatedAt: toCanonicalUtcIsoTimestamp(new Date()),
            dbPath: args.dbPath,
            window,
            strategy,
            sessions: sessionReports,
          },
          null,
          2,
        ),
        "utf8",
      );

      const episodeCount = sessionReports.reduce((sum, entry) => sum + entry.episodes.length, 0);
      overviewLines.push(`strategy=${strategy.id} episodes=${episodeCount}`);
    }

    await writeFile(path.join(outputRoot, "overview.txt"), overviewLines.join("\n"), "utf8");

    logger.info("meditation episode study finished", {
      outputRoot,
      dbPath: args.dbPath,
      windowStart: window.startAt,
      windowEnd: window.endAt,
      sessions: sessions.length,
    });
  } finally {
    db.close();
  }
}

function resolveStudySessions(input: {
  db: Database.Database;
  windowStart: string;
  windowEnd: string;
  requestedSessionIds: string[];
  topSessions: number;
}): SessionCountRow[] {
  if (input.requestedSessionIds.length > 0) {
    const stmt = input.db.prepare(
      `
        SELECT
          s.id AS sessionId,
          s.owner_agent_id AS ownerAgentId,
          a.display_name AS agentDisplayName,
          COALESCE(f.failedCount, 0) AS failedToolResultCount
        FROM sessions s
        LEFT JOIN agents a ON a.id = s.owner_agent_id
        LEFT JOIN (
          SELECT session_id AS sessionId, COUNT(*) AS failedCount
          FROM messages
          WHERE message_type = 'tool_result'
            AND created_at >= ?
            AND created_at <= ?
            AND json_extract(payload_json, '$.isError') = 1
            AND COALESCE(json_extract(payload_json, '$.details.code'), '') != ?
          GROUP BY session_id
        ) f ON f.sessionId = s.id
        WHERE s.id IN (${input.requestedSessionIds.map(() => "?").join(",")})
        ORDER BY failedToolResultCount DESC, s.id ASC
      `,
    );
    return stmt.all(
      input.windowStart,
      input.windowEnd,
      TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE,
      ...input.requestedSessionIds,
    ) as SessionCountRow[];
  }

  const stmt = input.db.prepare(
    `
      SELECT
        m.session_id AS sessionId,
        s.owner_agent_id AS ownerAgentId,
        a.display_name AS agentDisplayName,
        COUNT(*) AS failedToolResultCount
      FROM messages m
      INNER JOIN sessions s ON s.id = m.session_id
      LEFT JOIN agents a ON a.id = s.owner_agent_id
      WHERE m.message_type = 'tool_result'
        AND m.created_at >= ?
        AND m.created_at <= ?
        AND json_extract(m.payload_json, '$.isError') = 1
        AND COALESCE(json_extract(m.payload_json, '$.details.code'), '') != ?
      GROUP BY m.session_id, s.owner_agent_id, a.display_name
      ORDER BY failedToolResultCount DESC, m.session_id ASC
      LIMIT ?
    `,
  );
  return stmt.all(
    input.windowStart,
    input.windowEnd,
    TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE,
    input.topSessions,
  ) as SessionCountRow[];
}

function loadSessionMessages(input: {
  db: Database.Database;
  sessionId: string;
  windowStart: string;
  windowEnd: string;
}): SessionMessageRow[] {
  const stmt = input.db.prepare(
    `
      SELECT
        id,
        session_id AS sessionId,
        seq,
        role,
        message_type AS messageType,
        visibility,
        created_at AS createdAt,
        payload_json AS payloadJson
      FROM messages
      WHERE session_id = ?
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY seq ASC
    `,
  );

  return stmt.all(input.sessionId, input.windowStart, input.windowEnd) as SessionMessageRow[];
}

function parseRequiredDate(flag: string, rawValue: string | undefined): Date {
  if (rawValue == null) {
    throw new Error(`${flag} requires a value`);
  }
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} must be a valid ISO timestamp`);
  }
  return parsed;
}

function parsePositiveInteger(flag: string, rawValue: string): number {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function printUsageAndExit(exitCode: number): never {
  const lines = [
    "Meditation episode study",
    "",
    "Usage:",
    "  pnpm meditation:episode-study -- --tick-at <iso> [--lookback-days N | --start-at <iso> --end-at <iso>]",
    "      [--session-id <id>]... [--top-sessions N] [--db-path <path>] [--label <name>]",
    "",
    "Examples:",
    "  pnpm meditation:episode-study -- --tick-at 2026-04-15T12:30:00.000Z --lookback-days 7",
    "  pnpm meditation:episode-study -- --tick-at 2026-04-15T12:30:00.000Z --start-at 2026-04-14T00:00:00.000Z --end-at 2026-04-15T00:00:00.000Z --top-sessions 4",
    "  pnpm meditation:episode-study -- --tick-at 2026-04-15T12:30:00.000Z --session-id sess_1 --session-id sess_2",
    "",
    `Default DB path: ${path.join(os.homedir(), ".pokoclaw", "system", "pokoclaw.db")}`,
  ];
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${lines.join("\n")}\n`);
  process.exit(exitCode);
}

async function main(argv: string[]): Promise<void> {
  try {
    const args = parseMeditationEpisodeStudyArgs(argv);
    await runMeditationEpisodeStudy(args);
  } catch (error) {
    logger.error("meditation episode study failed", {
      error: error instanceof Error ? error.message : String(error),
      argv,
    });
    printUsageAndExit(1);
  }
}

const entryPath = process.argv[1];
const currentPath = fileURLToPath(import.meta.url);
if (entryPath != null && path.resolve(entryPath) === currentPath) {
  void main(process.argv.slice(2));
}
