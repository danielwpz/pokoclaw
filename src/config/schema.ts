export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggingConfig {
  level: LogLevel;
  useColors: boolean;
}

export interface RawConfig {
  logging: LoggingConfig;
}

export type SecretValueTree = {
  [key: string]: string | SecretValueTree;
};

export interface RawSecretsFile {
  root: SecretValueTree;
}

export interface AppConfig {
  logging: LoggingConfig;
  secrets: SecretValueTree;
}

interface FileConfigInput {
  logging?: {
    level?: unknown;
    useColors?: unknown;
  };
}

export type SecretsFileInput = Record<string, unknown>;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.includes(value as LogLevel);
}

export function validateFileConfig(input: unknown, defaults: RawConfig): RawConfig {
  if (input == null) {
    return {
      logging: { ...defaults.logging },
    };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("config.toml must contain a top-level table/object");
  }

  const config = input as FileConfigInput;
  const allowedRootKeys = new Set(["logging"]);
  for (const key of Object.keys(config)) {
    if (!allowedRootKeys.has(key)) {
      throw new Error(`config.toml contains unknown top-level key: ${key}`);
    }
  }

  const logging: LoggingConfig = { ...defaults.logging };
  if (config.logging != null) {
    if (typeof config.logging !== "object" || Array.isArray(config.logging)) {
      throw new Error("config.toml logging must be a table/object");
    }

    if (config.logging.level != null) {
      if (!isLogLevel(config.logging.level)) {
        throw new Error("config.toml logging.level must be one of: debug, info, warn, error");
      }
      logging.level = config.logging.level;
    }

    if (config.logging.useColors != null) {
      if (typeof config.logging.useColors !== "boolean") {
        throw new Error("config.toml logging.useColors must be a boolean");
      }
      logging.useColors = config.logging.useColors;
    }

    const allowedLoggingKeys = new Set(["level", "useColors"]);
    for (const key of Object.keys(config.logging)) {
      if (!allowedLoggingKeys.has(key)) {
        throw new Error(`config.toml logging contains unknown key: ${key}`);
      }
    }
  }

  return { logging };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSecretValueTree(
  input: Record<string, unknown>,
  pathSegments: string[],
): SecretValueTree {
  const validated: SecretValueTree = {};

  for (const [key, value] of Object.entries(input)) {
    const nextPathSegments = [...pathSegments, key];
    const nextPath = nextPathSegments.join(".");

    if (typeof value === "string") {
      validated[key] = value;
      continue;
    }

    if (isPlainObject(value)) {
      validated[key] = validateSecretValueTree(value, nextPathSegments);
      continue;
    }

    throw new Error(`secrets.toml ${nextPath} must be a string or table/object`);
  }

  return validated;
}

export function validateSecretsFile(input: unknown): RawSecretsFile {
  if (input == null) {
    return { root: {} };
  }

  if (!isPlainObject(input)) {
    throw new Error("secrets.toml must contain a top-level table/object");
  }

  return {
    root: validateSecretValueTree(input, []),
  };
}
