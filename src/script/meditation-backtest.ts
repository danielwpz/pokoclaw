/**
 * Meditation backtest CLI.
 *
 * Reuses the normal Meditation pipeline, but runs it inside an isolated sandbox
 * under `.tmp/meditation-backtests/<label>` so experiments do not mutate the
 * live workspace, live logs, or live meditation_state row.
 *
 * What it reuses:
 *   - the same MeditationPipelineRunner
 *   - the same prompts / clustering / evaluation / rewrite flow
 *   - the same runtime config and model wiring
 *
 * What it isolates:
 *   - a copied SQLite database
 *   - copied shared/private MEMORY.md files
 *   - sandboxed meditation logs and daily notes
 *   - meditation security policy hard-denies the live ~/.pokoclaw data tree
 *
 * Usage:
 *   pnpm meditation:backtest -- --tick-at 2026-04-15T12:30:00.000Z --lookback-days 7
 *
 *   pnpm meditation:backtest -- \
 *     --tick-at 2026-04-15T12:30:00.000Z \
 *     --start-at 2026-04-14T00:00:00.000Z \
 *     --end-at 2026-04-15T00:00:00.000Z \
 *     --label github-task-window
 *
 * Flags:
 *   --tick-at         Logical run time for the replay. Defaults to now.
 *   --start-at        Explicit UTC window start. If omitted, lookback logic is used.
 *   --end-at          Explicit UTC window end. Defaults to --tick-at.
 *   --lookback-days   Lookback horizon when --start-at is omitted.
 *   --last-success-at Override last_success_at semantics without touching live state.
 *                     Pass "null" to force lookback mode.
 *   --label           Sandbox folder label. Auto-generated when omitted.
 *
 * Output:
 *   The command logs the sandbox paths it used, including:
 *   - sandboxRoot
 *   - workspaceDir
 *   - logsDir
 *   - databasePath
 *
 * Typical workflow:
 *   1. Pick a tick time and either an explicit window or a lookback horizon.
 *   2. Run the backtest.
 *   3. Inspect the sandboxed meditation logs and workspace outputs.
 *   4. Delete the sandbox folder when you no longer need that replay.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { CodexProviderApiKeyResolver } from "@/src/agent/llm/providers/codex/resolver.js";
import { getDefaultConfigPaths, loadConfig } from "@/src/config/load.js";
import {
  buildDefaultMeditationBacktestSandboxPaths,
  buildMeditationBacktestRunRequest,
  buildMeditationBacktestSecurityConfig,
  prepareMeditationBacktestSandbox,
  sanitizeMeditationBacktestLabel,
} from "@/src/meditation/backtest.js";
import { MeditationPipelineRunner } from "@/src/meditation/runner.js";
import { configureRuntimeLogging, createSubsystemLogger } from "@/src/shared/logger.js";
import { openStorageDatabase } from "@/src/storage/index.js";
import { MeditationStateRepo } from "@/src/storage/repos/meditation-state.repo.js";

const logger = createSubsystemLogger("script/meditation-backtest");

interface ParsedArgs {
  tickAt: Date;
  startAt?: Date;
  endAt?: Date;
  lookbackDays?: number;
  lastSuccessAt?: string | null;
  label: string;
}

async function main(): Promise<void> {
  const args = parseMeditationBacktestArgs(process.argv.slice(2));
  const configPaths = getDefaultConfigPaths();
  const config = await loadConfig(configPaths);
  configureRuntimeLogging(config.logging);
  const securityConfig = buildMeditationBacktestSecurityConfig({
    securityConfig: config.security,
  });

  const sandbox = buildDefaultMeditationBacktestSandboxPaths({
    label: args.label,
  });
  await prepareMeditationBacktestSandbox({
    sandbox,
  });

  const storage = openStorageDatabase({
    databasePath: sandbox.databasePath,
    initializeSchema: true,
  });

  try {
    const runner = new MeditationPipelineRunner({
      storage: storage.db,
      state: new MeditationStateRepo(storage.db),
      config: config.selfHarness,
      models: new ProviderRegistry(config),
      bridge: new PiBridge(new CodexProviderApiKeyResolver()),
      securityConfig,
      workspaceDir: sandbox.workspaceDir,
      logsDir: sandbox.logsDir,
      createRunId: () => `backtest-${args.label}-${randomUUID()}`,
    });

    const result = await runner.runOnce(
      buildMeditationBacktestRunRequest({
        tickAt: args.tickAt,
        ...(args.startAt == null ? {} : { startAt: args.startAt }),
        ...(args.endAt == null ? {} : { endAt: args.endAt }),
        ...(args.lookbackDays == null ? {} : { lookbackDays: args.lookbackDays }),
        ...(args.lastSuccessAt === undefined ? {} : { lastSuccessAt: args.lastSuccessAt }),
      }),
    );

    logger.info("meditation backtest finished", {
      skipped: result.skipped,
      reason: result.reason ?? null,
      bucketsExecuted: result.bucketsExecuted,
      sandboxRoot: sandbox.rootDir,
      workspaceDir: sandbox.workspaceDir,
      logsDir: sandbox.logsDir,
      databasePath: sandbox.databasePath,
    });
  } finally {
    storage.close();
  }
}

export function parseMeditationBacktestArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const normalizedArgv = normalizeMeditationBacktestArgv(argv);
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const token = normalizedArgv[index];
    if (token === "--help") {
      printUsageAndExit(0);
    }
    if (token == null || !token.startsWith("--")) {
      printUsageAndExit(1, `Unexpected argument: ${token ?? "(missing)"}`);
    }

    const key = token.slice(2);
    const value = normalizedArgv[index + 1];
    if (value == null || value.startsWith("--")) {
      printUsageAndExit(1, `Missing value for --${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  const tickAt = parseDate(values.get("tick-at") ?? new Date().toISOString(), "--tick-at");
  const startAtValue = values.get("start-at");
  const endAtValue = values.get("end-at");
  const lookbackDaysValue = values.get("lookback-days");
  const lastSuccessAtValue = values.get("last-success-at");
  const label =
    values.get("label") ??
    sanitizeMeditationBacktestLabel(
      `${tickAt.toISOString().replace(/[:]/g, "-")}-${startAtValue ?? "lookback"}`,
    );

  return {
    tickAt,
    ...(startAtValue == null ? {} : { startAt: parseDate(startAtValue, "--start-at") }),
    ...(endAtValue == null ? {} : { endAt: parseDate(endAtValue, "--end-at") }),
    ...(lookbackDaysValue == null
      ? {}
      : { lookbackDays: parsePositiveInteger(lookbackDaysValue, "--lookback-days") }),
    ...(lastSuccessAtValue == null
      ? {}
      : { lastSuccessAt: lastSuccessAtValue === "null" ? null : lastSuccessAtValue }),
    label,
  };
}

export function normalizeMeditationBacktestArgv(argv: string[]): string[] {
  return argv.filter((token) => token !== "--");
}

function parseDate(value: string, flagName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    printUsageAndExit(1, `Invalid ${flagName} value: ${value}`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    printUsageAndExit(1, `Invalid ${flagName} value: ${value}`);
  }
  return parsed;
}

function printUsageAndExit(exitCode: number, errorMessage?: string): never {
  const lines = [
    "Usage:",
    "  pnpm meditation:backtest -- --tick-at <iso> [--lookback-days N | --start-at <iso> --end-at <iso>]",
    "                              [--last-success-at <iso|null>] [--label name]",
    "",
    "Description:",
    "  Replays the normal meditation pipeline inside an isolated sandbox under",
    "  .tmp/meditation-backtests/<label>/ without mutating live meditation state,",
    "  live logs, or live memory files.",
    "",
    "Flags:",
    "  --tick-at          Logical run time for the replay. Defaults to now when omitted.",
    "  --start-at         Explicit UTC window start. If omitted, lookback logic is used.",
    "  --end-at           Explicit UTC window end. Defaults to --tick-at.",
    "  --lookback-days    Lookback horizon when --start-at is omitted.",
    "  --last-success-at  Override meditation_state.last_success_at semantics for the replay.",
    "                     Pass null to force lookback mode without touching live state.",
    "  --label            Sandbox folder label under .tmp/meditation-backtests/.",
    "  --help             Show this usage text.",
    "",
    "Examples:",
    "  pnpm meditation:backtest -- --tick-at 2026-04-15T12:30:00.000Z --lookback-days 7",
    "  pnpm meditation:backtest -- --tick-at 2026-04-15T12:30:00.000Z --start-at 2026-04-14T00:00:00.000Z --end-at 2026-04-15T00:00:00.000Z --label github-task-window",
    "  pnpm meditation:backtest -- --tick-at 2026-04-15T12:30:00.000Z --lookback-days 7 --last-success-at null",
    "",
    "Outputs:",
    "  The script logs the sandboxRoot, workspaceDir, logsDir, and databasePath so",
    "  you can inspect the replay outputs directly after the run.",
  ];

  const output = [errorMessage, ...lines].filter(Boolean).join("\n");
  if (exitCode === 0) {
    console.log(output);
  } else {
    console.error(output);
  }
  process.exit(exitCode);
}

const isDirectExecution =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    logger.error("meditation backtest failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
