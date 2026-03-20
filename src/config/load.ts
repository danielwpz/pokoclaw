import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "toml";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { resolveConfigRefs } from "@/src/config/refs.js";
import {
  type AppConfig,
  type RawConfig,
  validateFileConfig,
  validateSecretsFile,
} from "@/src/config/schema.js";

interface LoadConfigOptions {
  configTomlPath?: string;
  secretsTomlPath?: string;
}

async function readOptionalTomlFile(filePath: string): Promise<unknown | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return parse(content);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load TOML file at ${filePath}: ${message}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getDefaultConfigPaths(homeDir = homedir()): Required<LoadConfigOptions> {
  return {
    configTomlPath: path.join(homeDir, ".pokeclaw", "config.toml"),
    secretsTomlPath: path.join(homeDir, ".pokeclaw", "secrets.toml"),
  };
}

async function loadConfigToml(configTomlPath: string): Promise<RawConfig> {
  const parsed = await readOptionalTomlFile(configTomlPath);
  return validateFileConfig(parsed, DEFAULT_CONFIG);
}

async function loadSecretsToml(secretsTomlPath: string): Promise<AppConfig["secrets"]> {
  const parsed = await readOptionalTomlFile(secretsTomlPath);
  return validateSecretsFile(parsed).root;
}

export async function loadConfig(options?: LoadConfigOptions): Promise<AppConfig> {
  const defaultPaths = getDefaultConfigPaths();
  const configTomlPath = options?.configTomlPath ?? defaultPaths.configTomlPath;
  const secretsTomlPath = options?.secretsTomlPath ?? defaultPaths.secretsTomlPath;

  const [rawConfig, secrets] = await Promise.all([
    loadConfigToml(configTomlPath),
    loadSecretsToml(secretsTomlPath),
  ]);

  const resolvedConfig = resolveConfigRefs(rawConfig, secrets);

  return {
    logging: resolvedConfig.logging,
    secrets,
  };
}
