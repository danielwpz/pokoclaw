import { readFile } from "node:fs/promises";
import { parse } from "toml";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { resolveConfigRefs } from "@/src/config/refs.js";
import { type AppConfig, validateFileConfig, validateSecretsFile } from "@/src/config/schema.js";
import { DEFAULT_CONFIG_TOML_PATH, DEFAULT_SECRETS_TOML_PATH } from "@/src/shared/paths.js";

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

function getDefaultConfigPaths(): Required<LoadConfigOptions> {
  return {
    configTomlPath: DEFAULT_CONFIG_TOML_PATH,
    secretsTomlPath: DEFAULT_SECRETS_TOML_PATH,
  };
}

async function loadConfigToml(configTomlPath: string): Promise<unknown | undefined> {
  return readOptionalTomlFile(configTomlPath);
}

async function loadSecretsToml(secretsTomlPath: string): Promise<unknown | undefined> {
  return readOptionalTomlFile(secretsTomlPath);
}

export async function loadConfig(options?: LoadConfigOptions): Promise<AppConfig> {
  const defaultPaths = getDefaultConfigPaths();
  const configTomlPath = options?.configTomlPath ?? defaultPaths.configTomlPath;
  const secretsTomlPath = options?.secretsTomlPath ?? defaultPaths.secretsTomlPath;

  const [rawConfigInput, rawSecretsInput] = await Promise.all([
    loadConfigToml(configTomlPath),
    loadSecretsToml(secretsTomlPath),
  ]);

  const secrets = validateSecretsFile(rawSecretsInput).root;
  const resolvedConfigInput = resolveConfigRefs(rawConfigInput, secrets);
  const resolvedConfig = validateFileConfig(resolvedConfigInput, DEFAULT_CONFIG);

  return {
    logging: resolvedConfig.logging,
    providers: resolvedConfig.providers,
    models: resolvedConfig.models,
    compaction: resolvedConfig.compaction,
    runtime: resolvedConfig.runtime,
    selfHarness: resolvedConfig.selfHarness,
    tools: resolvedConfig.tools,
    security: resolvedConfig.security,
    channels: resolvedConfig.channels,
    secrets,
  };
}
