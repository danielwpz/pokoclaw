import util from "node:util";

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
  now?: () => Date;
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
    .map(
      ([key, value]) =>
        `${key}=${util.inspect(value, { breakLength: Infinity, compact: true, depth: 4 })}`,
    );

  return entries.length > 0 ? ` ${entries.join(" ")}` : "";
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
  const now = options.now ?? (() => new Date());

  const log = (targetLevel: LogLevel, message: string, context?: LoggerContext): void => {
    if (!shouldLog(level, targetLevel)) {
      return;
    }

    write(formatLine(targetLevel, message, context, now(), options.subsystem, useColors));
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

async function getLoggingConfig(): Promise<LoggingConfig> {
  loggingConfigPromise ??= loadConfig().then((config) => config.logging);
  return loggingConfigPromise;
}

export async function createLogger(options: LoggerOptions): Promise<Logger> {
  const config = await getLoggingConfig();
  return createTestLogger(config, options);
}
