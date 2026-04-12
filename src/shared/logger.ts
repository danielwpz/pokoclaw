import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import util from "node:util";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { loadConfig } from "@/src/config/load.js";
import type { LoggingConfig, LogLevel } from "@/src/config/schema.js";
import { POKOCLAW_RUNTIME_LOG_PATH } from "@/src/shared/paths.js";

export interface LoggerContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LoggerContext): void;
  info(message: string, context?: LoggerContext): void;
  warn(message: string, context?: LoggerContext): void;
  error(message: string, context?: LoggerContext): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  subsystem: string;
}

export interface ConfigureRuntimeLoggingOptions {
  runtimeLogPath?: string;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ANSI_RESET = "\u001B[0m";
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\u001B[90m",
  info: "\u001B[36m",
  warn: "\u001B[33m",
  error: "\u001B[31m",
};

let loggingConfigPromise: Promise<LoggingConfig> | null = null;
let resolvedLoggingConfig: LoggingConfig | null = null;
let runtimeLogPath = POKOCLAW_RUNTIME_LOG_PATH;
let runtimeFileSinkEnabled = false;
let runtimeLogStream: WriteStream | null = null;
let runtimeLogStreamPath: string | null = null;
let runtimeLogSinkErrorPrinted = false;

function shouldLog(currentLevel: LogLevel, targetLevel: LogLevel): boolean {
  return LOG_LEVEL_ORDER[targetLevel] >= LOG_LEVEL_ORDER[currentLevel];
}

function formatLevelLabel(level: LogLevel, useColors: boolean): string {
  const label = level.toUpperCase();
  if (!useColors) {
    return label;
  }

  return `${LEVEL_COLORS[level]}${label}${ANSI_RESET}`;
}

function formatContext(context: LoggerContext | undefined): string {
  if (context == null) {
    return "";
  }

  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatContextValue(value)}`);

  return entries.length > 0 ? ` ${entries.join(" ")}` : "";
}

function formatContextValue(value: unknown): string {
  if (typeof value === "string") {
    return util.inspect(value, { breakLength: Infinity, compact: true });
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value == null
  ) {
    return String(value);
  }

  return util.inspect(value, { breakLength: Infinity, compact: true, depth: 1 });
}

function formatLine(
  level: LogLevel,
  message: string,
  context: LoggerContext | undefined,
  now: Date,
  subsystem: string,
  useColors: boolean,
): string {
  const timestamp = formatLocalTimestamp(now);
  const levelLabel = formatLevelLabel(level, useColors);
  return `${timestamp} ${levelLabel} [${subsystem}] ${message}${formatContext(context)}`;
}

function formatLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function createLoggerWithLevel(
  level: LogLevel,
  useColors: boolean,
  options: LoggerOptions,
): Logger {
  const write = options.write ?? ((line: string) => console.error(line));

  const log = (targetLevel: LogLevel, message: string, context?: LoggerContext): void => {
    if (!shouldLog(level, targetLevel)) {
      return;
    }

    const now = new Date();
    write(formatLine(targetLevel, message, context, now, options.subsystem, useColors));
    writeRuntimeFileLine(targetLevel, message, context, now, options.subsystem);
  };

  return {
    debug(message, context) {
      log("debug", message, context);
    },
    info(message, context) {
      log("info", message, context);
    },
    warn(message, context) {
      log("warn", message, context);
    },
    error(message, context) {
      log("error", message, context);
    },
  };
}

export function createBootstrapLogger(options: LoggerOptions): Logger {
  return createLoggerWithLevel("info", false, options);
}

export function createTestLogger(config: LoggingConfig, options: LoggerOptions): Logger {
  return createLoggerWithLevel(config.level, config.useColors, options);
}

async function getLoggingConfig(): Promise<LoggingConfig> {
  loggingConfigPromise ??= loadConfig().then((config) => {
    resolvedLoggingConfig = config.logging;
    return config.logging;
  });
  return loggingConfigPromise;
}

export async function createLogger(options: LoggerOptions): Promise<Logger> {
  const config = await getLoggingConfig();
  return createTestLogger(config, options);
}

export function configureRuntimeLogging(
  config: LoggingConfig,
  options: ConfigureRuntimeLoggingOptions = {},
): void {
  resolvedLoggingConfig = config;
  runtimeFileSinkEnabled = true;
  runtimeLogPath = options.runtimeLogPath ?? POKOCLAW_RUNTIME_LOG_PATH;
  if (runtimeLogStreamPath != null && runtimeLogStreamPath !== runtimeLogPath) {
    void closeRuntimeLogStream();
  }
}

export async function flushRuntimeLoggingForTests(): Promise<void> {
  if (runtimeLogStream == null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    runtimeLogStream?.write("", (error) => {
      if (error != null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function resetRuntimeLoggingForTests(): Promise<void> {
  runtimeFileSinkEnabled = false;
  runtimeLogPath = POKOCLAW_RUNTIME_LOG_PATH;
  loggingConfigPromise = null;
  resolvedLoggingConfig = null;
  await closeRuntimeLogStream();
}

export function createSubsystemLogger(subsystem: string): Logger {
  let logger =
    resolvedLoggingConfig == null
      ? createTestLogger(DEFAULT_CONFIG.logging, { subsystem })
      : createTestLogger(resolvedLoggingConfig, { subsystem });
  let loading: Promise<void> | null = null;

  const ensureConfiguredLogger = () => {
    if (resolvedLoggingConfig != null) {
      logger = createTestLogger(resolvedLoggingConfig, { subsystem });
      return;
    }
    if (loading != null) {
      return;
    }

    loading = getLoggingConfig()
      .then((config) => {
        logger = createTestLogger(config, { subsystem });
      })
      .catch(() => {})
      .finally(() => {
        loading = null;
      });
  };

  return {
    debug(message, context) {
      ensureConfiguredLogger();
      logger.debug(message, context);
    },
    info(message, context) {
      ensureConfiguredLogger();
      logger.info(message, context);
    },
    warn(message, context) {
      ensureConfiguredLogger();
      logger.warn(message, context);
    },
    error(message, context) {
      ensureConfiguredLogger();
      logger.error(message, context);
    },
  };
}

function writeRuntimeFileLine(
  level: LogLevel,
  message: string,
  context: LoggerContext | undefined,
  now: Date,
  subsystem: string,
): void {
  if (!runtimeFileSinkEnabled || !shouldLog("info", level)) {
    return;
  }

  const stream = ensureRuntimeLogStream();
  if (stream == null) {
    return;
  }

  stream.write(`${formatLine(level, message, context, now, subsystem, false)}\n`);
}

function ensureRuntimeLogStream(): WriteStream | null {
  if (!runtimeFileSinkEnabled) {
    return null;
  }

  if (
    runtimeLogStream != null &&
    runtimeLogStreamPath === runtimeLogPath &&
    !runtimeLogStream.destroyed
  ) {
    return runtimeLogStream;
  }

  void closeRuntimeLogStream();

  try {
    mkdirSync(path.dirname(runtimeLogPath), { recursive: true });
    const stream = createWriteStream(runtimeLogPath, {
      flags: "a",
      encoding: "utf8",
    });
    stream.on("error", (error) => {
      reportRuntimeLogSinkError(error);
    });
    runtimeLogStream = stream;
    runtimeLogStreamPath = runtimeLogPath;
    runtimeLogSinkErrorPrinted = false;
    return stream;
  } catch (error) {
    reportRuntimeLogSinkError(error);
    return null;
  }
}

function closeRuntimeLogStream(): Promise<void> {
  if (runtimeLogStream == null) {
    runtimeLogStreamPath = null;
    return Promise.resolve();
  }

  const stream = runtimeLogStream;
  runtimeLogStream = null;
  runtimeLogStreamPath = null;

  return new Promise((resolve) => {
    stream.end(() => {
      resolve();
    });
  });
}

function reportRuntimeLogSinkError(error: unknown): void {
  if (runtimeLogSinkErrorPrinted) {
    return;
  }

  runtimeLogSinkErrorPrinted = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to write runtime log file at ${runtimeLogPath}: ${message}`);
}
