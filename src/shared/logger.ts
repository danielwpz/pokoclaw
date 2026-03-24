import util from "node:util";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { loadConfig } from "@/src/config/load.js";
import type { LoggingConfig, LogLevel } from "@/src/config/schema.js";

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
  const timestamp = now.toISOString();
  const levelLabel = formatLevelLabel(level, useColors);
  return `${timestamp} ${levelLabel} [${subsystem}] ${message}${formatContext(context)}`;
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

    write(formatLine(targetLevel, message, context, new Date(), options.subsystem, useColors));
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

let loggingConfigPromise: Promise<LoggingConfig> | null = null;
let resolvedLoggingConfig: LoggingConfig | null = null;

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
