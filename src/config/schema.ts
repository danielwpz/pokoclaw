export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggingConfig {
  level: LogLevel;
  useColors: boolean;
}

export interface ProviderConfig {
  api: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ModelPricingConfig {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  upstreamId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  pricing?: ModelPricingConfig;
}

export interface ModelScenarioConfig {
  chat: string[];
  compaction: string[];
  subagent: string[];
  cron: string[];
}

export interface ModelsConfig {
  catalog: ModelCatalogEntry[];
  scenarios: ModelScenarioConfig;
}

export interface CompactionConfig {
  reserveTokens: number;
  keepRecentTokens: number;
  reserveTokensFloor: number;
  recentTurnsPreserve: number;
}

export interface RawConfig {
  logging: LoggingConfig;
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  compaction: CompactionConfig;
}

export type SecretValueTree = {
  [key: string]: string | SecretValueTree;
};

export interface RawSecretsFile {
  root: SecretValueTree;
}

export interface AppConfig extends RawConfig {
  secrets: SecretValueTree;
}

interface LoggingConfigInput {
  level?: unknown;
  useColors?: unknown;
}

interface ProviderConfigInput {
  api?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
}

interface ModelPricingConfigInput {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

interface ModelCatalogEntryInput {
  id?: unknown;
  provider?: unknown;
  upstreamId?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  supportsTools?: unknown;
  supportsVision?: unknown;
  supportsReasoning?: unknown;
  pricing?: unknown;
}

interface ModelScenarioConfigInput {
  chat?: unknown;
  compaction?: unknown;
  subagent?: unknown;
  cron?: unknown;
}

interface ModelsConfigInput {
  catalog?: unknown;
  scenarios?: unknown;
}

interface CompactionConfigInput {
  reserveTokens?: unknown;
  keepRecentTokens?: unknown;
  reserveTokensFloor?: unknown;
  recentTurnsPreserve?: unknown;
}

interface FileConfigInput {
  logging?: unknown;
  providers?: unknown;
  models?: unknown;
  compaction?: unknown;
}

export type SecretsFileInput = Record<string, unknown>;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const MODEL_SCENARIOS = ["chat", "compaction", "subagent", "cron"] as const;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LOG_LEVELS.includes(value as LogLevel);
}

export function validateFileConfig(input: unknown, defaults: RawConfig): RawConfig {
  if (input == null) {
    return cloneRawConfig(defaults);
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml must contain a top-level table/object");
  }

  const config = input as FileConfigInput;
  const allowedRootKeys = new Set(["logging", "providers", "models", "compaction"]);
  for (const key of Object.keys(config)) {
    if (!allowedRootKeys.has(key)) {
      throw new Error(`config.toml contains unknown top-level key: ${key}`);
    }
  }

  const logging = validateLoggingConfig(config.logging, defaults.logging);
  const providers = validateProvidersConfig(config.providers, defaults.providers);
  const models = validateModelsConfig(config.models, defaults.models, providers);
  const compaction = validateCompactionConfig(config.compaction, defaults.compaction);

  if (compaction.reserveTokensFloor > compaction.reserveTokens) {
    throw new Error("config.toml compaction.reserveTokensFloor cannot exceed reserveTokens");
  }

  return {
    logging,
    providers,
    models,
    compaction,
  };
}

function cloneRawConfig(config: RawConfig): RawConfig {
  return {
    logging: { ...config.logging },
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([key, provider]) => [
        key,
        cloneProviderConfig(provider),
      ]),
    ),
    models: {
      catalog: config.models.catalog.map(cloneModelCatalogEntry),
      scenarios: {
        chat: [...config.models.scenarios.chat],
        compaction: [...config.models.scenarios.compaction],
        subagent: [...config.models.scenarios.subagent],
        cron: [...config.models.scenarios.cron],
      },
    },
    compaction: { ...config.compaction },
  };
}

function validateLoggingConfig(input: unknown, defaults: LoggingConfig): LoggingConfig {
  if (input == null) {
    return { ...defaults };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml logging must be a table/object");
  }

  const config = input as LoggingConfigInput;
  assertAllowedKeys(config, new Set(["level", "useColors"]), "config.toml logging");

  const logging: LoggingConfig = { ...defaults };

  if (config.level != null) {
    if (!isLogLevel(config.level)) {
      throw new Error("config.toml logging.level must be one of: debug, info, warn, error");
    }
    logging.level = config.level;
  }

  if (config.useColors != null) {
    if (typeof config.useColors !== "boolean") {
      throw new Error("config.toml logging.useColors must be a boolean");
    }
    logging.useColors = config.useColors;
  }

  return logging;
}

function validateProvidersConfig(
  input: unknown,
  defaults: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  if (input == null) {
    return Object.fromEntries(
      Object.entries(defaults).map(([key, provider]) => [key, cloneProviderConfig(provider)]),
    );
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml providers must be a table/object");
  }

  const providers: Record<string, ProviderConfig> = {};

  for (const [providerId, providerValue] of Object.entries(input)) {
    if (!isPlainObject(providerValue)) {
      throw new Error(`config.toml providers.${providerId} must be a table/object`);
    }

    const provider = providerValue as ProviderConfigInput;
    assertAllowedKeys(
      provider,
      new Set(["api", "baseUrl", "apiKey"]),
      `config.toml providers.${providerId}`,
    );

    const normalizedProvider: ProviderConfig = {
      api: validateNonEmptyString(provider.api, `config.toml providers.${providerId}.api`),
    };

    const baseUrl = validateOptionalNonEmptyString(
      provider.baseUrl,
      `config.toml providers.${providerId}.baseUrl`,
    );
    if (baseUrl != null) {
      normalizedProvider.baseUrl = baseUrl;
    }

    const apiKey = validateOptionalNonEmptyString(
      provider.apiKey,
      `config.toml providers.${providerId}.apiKey`,
    );
    if (apiKey != null) {
      normalizedProvider.apiKey = apiKey;
    }

    providers[providerId] = normalizedProvider;
  }

  return providers;
}

function validateModelsConfig(
  input: unknown,
  defaults: ModelsConfig,
  providers: Record<string, ProviderConfig>,
): ModelsConfig {
  if (input == null) {
    return {
      catalog: defaults.catalog.map(cloneModelCatalogEntry),
      scenarios: {
        chat: [...defaults.scenarios.chat],
        compaction: [...defaults.scenarios.compaction],
        subagent: [...defaults.scenarios.subagent],
        cron: [...defaults.scenarios.cron],
      },
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml models must be a table/object");
  }

  const config = input as ModelsConfigInput;
  assertAllowedKeys(config, new Set(["catalog", "scenarios"]), "config.toml models");

  const catalog = validateModelCatalog(config.catalog, defaults.catalog, providers);
  const catalogIds = new Set(catalog.map((entry) => entry.id));
  const scenarios = validateModelScenarios(config.scenarios, defaults.scenarios, catalogIds);

  return {
    catalog,
    scenarios,
  };
}

function validateModelCatalog(
  input: unknown,
  defaults: ModelCatalogEntry[],
  providers: Record<string, ProviderConfig>,
): ModelCatalogEntry[] {
  if (input == null) {
    return defaults.map(cloneModelCatalogEntry);
  }

  if (!Array.isArray(input)) {
    throw new Error("config.toml models.catalog must be an array");
  }

  const seenIds = new Set<string>();

  return input.map((entryValue, index) => {
    if (!isPlainObject(entryValue)) {
      throw new Error(`config.toml models.catalog[${index}] must be a table/object`);
    }

    const entry = entryValue as ModelCatalogEntryInput;
    assertAllowedKeys(
      entry,
      new Set([
        "id",
        "provider",
        "upstreamId",
        "contextWindow",
        "maxOutputTokens",
        "supportsTools",
        "supportsVision",
        "supportsReasoning",
        "pricing",
      ]),
      `config.toml models.catalog[${index}]`,
    );

    const id = validateNonEmptyString(entry.id, `config.toml models.catalog[${index}].id`);
    if (seenIds.has(id)) {
      throw new Error(`config.toml models.catalog contains duplicate id: ${id}`);
    }
    seenIds.add(id);

    const provider = validateNonEmptyString(
      entry.provider,
      `config.toml models.catalog[${index}].provider`,
    );
    if (!Object.hasOwn(providers, provider)) {
      throw new Error(
        `config.toml models.catalog[${index}].provider references unknown provider: ${provider}`,
      );
    }

    const normalizedEntry: ModelCatalogEntry = {
      id,
      provider,
      upstreamId: validateNonEmptyString(
        entry.upstreamId,
        `config.toml models.catalog[${index}].upstreamId`,
      ),
      contextWindow: validatePositiveInteger(
        entry.contextWindow,
        `config.toml models.catalog[${index}].contextWindow`,
      ),
      maxOutputTokens: validatePositiveInteger(
        entry.maxOutputTokens,
        `config.toml models.catalog[${index}].maxOutputTokens`,
      ),
      supportsTools: validateBoolean(
        entry.supportsTools,
        `config.toml models.catalog[${index}].supportsTools`,
      ),
      supportsVision: validateBoolean(
        entry.supportsVision,
        `config.toml models.catalog[${index}].supportsVision`,
      ),
      supportsReasoning: validateBoolean(
        entry.supportsReasoning,
        `config.toml models.catalog[${index}].supportsReasoning`,
      ),
    };

    const pricing = validatePricingConfig(
      entry.pricing,
      `config.toml models.catalog[${index}].pricing`,
    );
    if (pricing != null) {
      normalizedEntry.pricing = pricing;
    }

    return normalizedEntry;
  });
}

function validatePricingConfig(input: unknown, path: string): ModelPricingConfig | undefined {
  if (input == null) {
    return undefined;
  }

  if (!isPlainObject(input)) {
    throw new Error(`${path} must be a table/object`);
  }

  const pricing = input as ModelPricingConfigInput;
  assertAllowedKeys(pricing, new Set(["input", "output", "cacheRead", "cacheWrite"]), path);

  return {
    input: validateNonNegativeNumber(pricing.input, `${path}.input`),
    output: validateNonNegativeNumber(pricing.output, `${path}.output`),
    cacheRead: validateNonNegativeNumber(pricing.cacheRead, `${path}.cacheRead`),
    cacheWrite: validateNonNegativeNumber(pricing.cacheWrite, `${path}.cacheWrite`),
  };
}

function validateModelScenarios(
  input: unknown,
  defaults: ModelScenarioConfig,
  catalogIds: Set<string>,
): ModelScenarioConfig {
  if (input == null) {
    return {
      chat: [...defaults.chat],
      compaction: [...defaults.compaction],
      subagent: [...defaults.subagent],
      cron: [...defaults.cron],
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml models.scenarios must be a table/object");
  }

  const scenarios = input as ModelScenarioConfigInput;
  assertAllowedKeys(scenarios, new Set(MODEL_SCENARIOS), "config.toml models.scenarios");

  return {
    chat: validateScenarioList(scenarios.chat, defaults.chat, catalogIds, "chat"),
    compaction: validateScenarioList(
      scenarios.compaction,
      defaults.compaction,
      catalogIds,
      "compaction",
    ),
    subagent: validateScenarioList(scenarios.subagent, defaults.subagent, catalogIds, "subagent"),
    cron: validateScenarioList(scenarios.cron, defaults.cron, catalogIds, "cron"),
  };
}

function validateScenarioList(
  input: unknown,
  defaults: string[],
  catalogIds: Set<string>,
  scenarioName: string,
): string[] {
  if (input == null) {
    return [...defaults];
  }

  if (!Array.isArray(input)) {
    throw new Error(`config.toml models.scenarios.${scenarioName} must be an array`);
  }

  const values = input.map((value, index) =>
    validateNonEmptyString(value, `config.toml models.scenarios.${scenarioName}[${index}]`),
  );
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) {
    throw new Error(`config.toml models.scenarios.${scenarioName} contains duplicate model ids`);
  }

  for (const value of values) {
    if (!catalogIds.has(value)) {
      throw new Error(
        `config.toml models.scenarios.${scenarioName} references unknown model id: ${value}`,
      );
    }
  }

  return values;
}

function validateCompactionConfig(input: unknown, defaults: CompactionConfig): CompactionConfig {
  if (input == null) {
    return { ...defaults };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml compaction must be a table/object");
  }

  const config = input as CompactionConfigInput;
  assertAllowedKeys(
    config,
    new Set(["reserveTokens", "keepRecentTokens", "reserveTokensFloor", "recentTurnsPreserve"]),
    "config.toml compaction",
  );

  return {
    reserveTokens: validatePositiveInteger(
      config.reserveTokens ?? defaults.reserveTokens,
      "config.toml compaction.reserveTokens",
    ),
    keepRecentTokens: validatePositiveInteger(
      config.keepRecentTokens ?? defaults.keepRecentTokens,
      "config.toml compaction.keepRecentTokens",
    ),
    reserveTokensFloor: validatePositiveInteger(
      config.reserveTokensFloor ?? defaults.reserveTokensFloor,
      "config.toml compaction.reserveTokensFloor",
    ),
    recentTurnsPreserve: validateNonNegativeInteger(
      config.recentTurnsPreserve ?? defaults.recentTurnsPreserve,
      "config.toml compaction.recentTurnsPreserve",
    ),
  };
}

function assertAllowedKeys(input: object, allowedKeys: Set<string>, path: string): void {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${path} contains unknown key: ${key}`);
    }
  }
}

function cloneProviderConfig(provider: ProviderConfig): ProviderConfig {
  const cloned: ProviderConfig = {
    api: provider.api,
  };

  if (provider.baseUrl != null) {
    cloned.baseUrl = provider.baseUrl;
  }

  if (provider.apiKey != null) {
    cloned.apiKey = provider.apiKey;
  }

  return cloned;
}

function cloneModelCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
  const cloned: ModelCatalogEntry = {
    id: entry.id,
    provider: entry.provider,
    upstreamId: entry.upstreamId,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    supportsTools: entry.supportsTools,
    supportsVision: entry.supportsVision,
    supportsReasoning: entry.supportsReasoning,
  };

  if (entry.pricing != null) {
    cloned.pricing = { ...entry.pricing };
  }

  return cloned;
}

function validateNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function validateOptionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value == null) {
    return undefined;
  }

  return validateNonEmptyString(value, path);
}

function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }

  return value;
}

function validatePositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }

  return value as number;
}

function validateNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }

  return value as number;
}

function validateNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }

  return value;
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
