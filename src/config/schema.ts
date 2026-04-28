import { computeNextRunAt } from "@/src/cron/schedule.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggingConfig {
  level: LogLevel;
  useColors: boolean;
}

export type ProviderAuthSource = "config" | "codex-local";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProviderConfig {
  api: string;
  baseUrl?: string;
  apiKey?: string;
  authSource?: ProviderAuthSource;
}

export interface ModelPricingConfig {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelReasoningConfig {
  enabled: boolean;
  effort?: ReasoningEffort;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  upstreamId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  reasoning?: ModelReasoningConfig;
  pricing?: ModelPricingConfig;
}

export interface ModelScenarioConfig {
  chat: string[];
  compaction: string[];
  task: string[];
  meditationBucket: string[];
  meditationConsolidation: string[];
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

export interface RuntimeConfig {
  maxTurns: number;
  approvalTimeoutMs: number;
  approvalGrantTtlMs: number;
  autopilot: boolean;
}

export interface ProjectContextConfig {
  enabled: boolean;
  maxBytes: number;
  files: string[];
}

export interface MeditationConfig {
  enabled: boolean;
  cron: string;
}

export interface SelfHarnessConfig {
  meditation: MeditationConfig;
}

export interface WebToolConfig {
  enabled: boolean;
  provider?: string;
}

export interface WebToolsConfig {
  search: WebToolConfig;
  fetch: WebToolConfig;
}

export interface ToolsConfig {
  web: WebToolsConfig;
}

export interface SecurityFilesystemConfig {
  overrideHardDenyRead: boolean;
  overrideHardDenyWrite: boolean;
  hardDenyRead: string[];
  hardDenyWrite: string[];
}

export interface SecurityNetworkConfig {
  overrideHardDenyHosts: boolean;
  hardDenyHosts: string[];
}

export interface SecurityConfig {
  filesystem: SecurityFilesystemConfig;
  network: SecurityNetworkConfig;
}

export type LarkConnectionMode = "websocket" | "webhook";

export interface LarkInstallationConfig {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  connectionMode: LarkConnectionMode;
}

export interface LarkChannelConfig {
  installations: Record<string, LarkInstallationConfig>;
}

export interface ChannelsConfig {
  lark: LarkChannelConfig;
}

export interface RawConfig {
  logging: LoggingConfig;
  providers: Record<string, ProviderConfig>;
  models: ModelsConfig;
  compaction: CompactionConfig;
  runtime: RuntimeConfig;
  projectContext: ProjectContextConfig;
  selfHarness: SelfHarnessConfig;
  tools: ToolsConfig;
  security: SecurityConfig;
  channels: ChannelsConfig;
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
  authSource?: unknown;
}

interface ModelPricingConfigInput {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

interface ModelReasoningConfigInput {
  enabled?: unknown;
  effort?: unknown;
}

interface ModelCatalogEntryInput {
  id?: unknown;
  provider?: unknown;
  upstreamId?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  supportsTools?: unknown;
  supportsVision?: unknown;
  reasoning?: unknown;
  pricing?: unknown;
}

interface ModelScenarioConfigInput {
  chat?: unknown;
  compaction?: unknown;
  task?: unknown;
  meditationBucket?: unknown;
  meditationConsolidation?: unknown;
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

interface RuntimeConfigInput {
  maxTurns?: unknown;
  approvalTimeoutMs?: unknown;
  approvalGrantTtlMs?: unknown;
  autopilot?: unknown;
}

interface ProjectContextConfigInput {
  enabled?: unknown;
  max_bytes?: unknown;
  files?: unknown;
}

interface MeditationConfigInput {
  enabled?: unknown;
  cron?: unknown;
}

interface SelfHarnessConfigInput {
  meditation?: unknown;
}

interface WebToolConfigInput {
  enabled?: unknown;
  provider?: unknown;
}

interface WebToolsConfigInput {
  search?: unknown;
  fetch?: unknown;
}

interface ToolsConfigInput {
  web?: unknown;
}

interface SecurityFilesystemConfigInput {
  overrideHardDenyRead?: unknown;
  overrideHardDenyWrite?: unknown;
  hardDenyRead?: unknown;
  hardDenyWrite?: unknown;
}

interface SecurityNetworkConfigInput {
  overrideHardDenyHosts?: unknown;
  hardDenyHosts?: unknown;
}

interface SecurityConfigInput {
  filesystem?: unknown;
  network?: unknown;
}

interface LarkInstallationConfigInput {
  enabled?: unknown;
  appId?: unknown;
  appSecret?: unknown;
  connectionMode?: unknown;
}

interface LarkChannelConfigInput {
  installations?: unknown;
}

interface ChannelsConfigInput {
  lark?: unknown;
}

interface FileConfigInput {
  logging?: unknown;
  providers?: unknown;
  models?: unknown;
  compaction?: unknown;
  runtime?: unknown;
  project_context?: unknown;
  "self-harness"?: unknown;
  tools?: unknown;
  security?: unknown;
  channels?: unknown;
}

export type SecretsFileInput = Record<string, unknown>;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const MODEL_SCENARIOS = [
  "chat",
  "compaction",
  "task",
  "meditationBucket",
  "meditationConsolidation",
] as const;
const LARK_CONNECTION_MODES: readonly LarkConnectionMode[] = ["websocket", "webhook"];
const PROVIDER_AUTH_SOURCES: readonly ProviderAuthSource[] = ["config", "codex-local"];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

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
  const allowedRootKeys = new Set([
    "logging",
    "providers",
    "models",
    "compaction",
    "runtime",
    "project_context",
    "self-harness",
    "tools",
    "security",
    "channels",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowedRootKeys.has(key)) {
      throw new Error(`config.toml contains unknown top-level key: ${key}`);
    }
  }

  const logging = validateLoggingConfig(config.logging, defaults.logging);
  const providers = validateProvidersConfig(config.providers, defaults.providers);
  const models = validateModelsConfig(config.models, defaults.models, providers);
  const compaction = validateCompactionConfig(config.compaction, defaults.compaction);
  const runtime = validateRuntimeConfig(config.runtime, defaults.runtime);
  const projectContext = validateProjectContextConfig(
    config.project_context,
    defaults.projectContext,
  );
  const selfHarness = validateSelfHarnessConfig(config["self-harness"], defaults.selfHarness);
  const tools = validateToolsConfig(config.tools, defaults.tools, providers);
  const security = validateSecurityConfig(config.security, defaults.security);
  const channels = validateChannelsConfig(config.channels, defaults.channels);

  if (compaction.reserveTokensFloor > compaction.reserveTokens) {
    throw new Error("config.toml compaction.reserveTokensFloor cannot exceed reserveTokens");
  }

  return {
    logging,
    providers,
    models,
    compaction,
    runtime,
    projectContext,
    selfHarness,
    tools,
    security,
    channels,
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
        task: [...config.models.scenarios.task],
        meditationBucket: [...config.models.scenarios.meditationBucket],
        meditationConsolidation: [...config.models.scenarios.meditationConsolidation],
      },
    },
    compaction: { ...config.compaction },
    runtime: { ...config.runtime },
    projectContext: {
      enabled: config.projectContext.enabled,
      maxBytes: config.projectContext.maxBytes,
      files: [...config.projectContext.files],
    },
    selfHarness: {
      meditation: cloneMeditationConfig(config.selfHarness.meditation),
    },
    tools: {
      web: {
        search: cloneWebToolConfig(config.tools.web.search),
        fetch: cloneWebToolConfig(config.tools.web.fetch),
      },
    },
    security: {
      filesystem: {
        overrideHardDenyRead: config.security.filesystem.overrideHardDenyRead,
        overrideHardDenyWrite: config.security.filesystem.overrideHardDenyWrite,
        hardDenyRead: [...config.security.filesystem.hardDenyRead],
        hardDenyWrite: [...config.security.filesystem.hardDenyWrite],
      },
      network: {
        overrideHardDenyHosts: config.security.network.overrideHardDenyHosts,
        hardDenyHosts: [...config.security.network.hardDenyHosts],
      },
    },
    channels: {
      lark: {
        installations: Object.fromEntries(
          Object.entries(config.channels.lark.installations).map(([key, installation]) => [
            key,
            { ...installation },
          ]),
        ),
      },
    },
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
      new Set(["api", "baseUrl", "apiKey", "authSource"]),
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

    const authSource = validateOptionalProviderAuthSource(
      provider.authSource,
      `config.toml providers.${providerId}.authSource`,
    );
    if (authSource != null) {
      normalizedProvider.authSource = authSource;
    }

    if (normalizedProvider.authSource === "codex-local") {
      if (normalizedProvider.api !== "openai-codex-responses") {
        throw new Error(
          `config.toml providers.${providerId}.authSource = "codex-local" requires api = "openai-codex-responses"`,
        );
      }
      if (normalizedProvider.baseUrl != null) {
        throw new Error(
          `config.toml providers.${providerId} cannot set baseUrl when authSource = "codex-local"`,
        );
      }
    }

    if (normalizedProvider.authSource === "codex-local" && normalizedProvider.apiKey != null) {
      throw new Error(
        `config.toml providers.${providerId} cannot set both authSource = "codex-local" and apiKey`,
      );
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
        task: [...defaults.scenarios.task],
        meditationBucket: [...defaults.scenarios.meditationBucket],
        meditationConsolidation: [...defaults.scenarios.meditationConsolidation],
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
        "reasoning",
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
    };

    const reasoning = validateReasoningConfig(
      entry.reasoning,
      `config.toml models.catalog[${index}].reasoning`,
    );
    if (reasoning != null) {
      normalizedEntry.reasoning = reasoning;
    }

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
      task: [...defaults.task],
      meditationBucket: [...defaults.meditationBucket],
      meditationConsolidation: [...defaults.meditationConsolidation],
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
    task: validateScenarioList(scenarios.task, defaults.task, catalogIds, "task"),
    meditationBucket: validateScenarioList(
      scenarios.meditationBucket,
      defaults.meditationBucket,
      catalogIds,
      "meditationBucket",
    ),
    meditationConsolidation: validateScenarioList(
      scenarios.meditationConsolidation,
      defaults.meditationConsolidation,
      catalogIds,
      "meditationConsolidation",
    ),
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

function validateRuntimeConfig(input: unknown, defaults: RuntimeConfig): RuntimeConfig {
  if (input == null) {
    return { ...defaults };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml runtime must be a table/object");
  }

  const config = input as RuntimeConfigInput;
  assertAllowedKeys(
    config,
    new Set(["maxTurns", "approvalTimeoutMs", "approvalGrantTtlMs", "autopilot"]),
    "config.toml runtime",
  );

  return {
    maxTurns: validatePositiveInteger(
      config.maxTurns ?? defaults.maxTurns,
      "config.toml runtime.maxTurns",
    ),
    approvalTimeoutMs: validatePositiveInteger(
      config.approvalTimeoutMs ?? defaults.approvalTimeoutMs,
      "config.toml runtime.approvalTimeoutMs",
    ),
    approvalGrantTtlMs: validatePositiveInteger(
      config.approvalGrantTtlMs ?? defaults.approvalGrantTtlMs,
      "config.toml runtime.approvalGrantTtlMs",
    ),
    autopilot: validateOptionalBoolean(
      config.autopilot,
      defaults.autopilot,
      "config.toml runtime.autopilot",
    ),
  };
}

function validateProjectContextConfig(
  input: unknown,
  defaults: ProjectContextConfig,
): ProjectContextConfig {
  if (input == null) {
    return {
      enabled: defaults.enabled,
      maxBytes: defaults.maxBytes,
      files: [...defaults.files],
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml project_context must be a table/object");
  }

  const config = input as ProjectContextConfigInput;
  assertAllowedKeys(
    config,
    new Set(["enabled", "max_bytes", "files"]),
    "config.toml project_context",
  );

  return {
    enabled: validateOptionalBoolean(
      config.enabled,
      defaults.enabled,
      "config.toml project_context.enabled",
    ),
    maxBytes: validatePositiveInteger(
      config.max_bytes ?? defaults.maxBytes,
      "config.toml project_context.max_bytes",
    ),
    files: validateProjectContextFiles(
      config.files,
      defaults.files,
      "config.toml project_context.files",
    ),
  };
}

function validateSelfHarnessConfig(input: unknown, defaults: SelfHarnessConfig): SelfHarnessConfig {
  if (input == null) {
    return {
      meditation: cloneMeditationConfig(defaults.meditation),
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml self-harness must be a table/object");
  }

  const config = input as SelfHarnessConfigInput;
  assertAllowedKeys(config, new Set(["meditation"]), "config.toml self-harness");

  return {
    meditation: validateMeditationConfig(
      config.meditation,
      defaults.meditation,
      "config.toml self-harness.meditation",
    ),
  };
}

function validateMeditationConfig(
  input: unknown,
  defaults: MeditationConfig,
  path: string,
): MeditationConfig {
  if (input == null) {
    return cloneMeditationConfig(defaults);
  }

  if (!isPlainObject(input)) {
    throw new Error(`${path} must be a table/object`);
  }

  const config = input as MeditationConfigInput;
  assertAllowedKeys(config, new Set(["enabled", "cron"]), path);

  return {
    enabled:
      config.enabled == null
        ? defaults.enabled
        : validateBoolean(config.enabled, `${path}.enabled`),
    cron: validateMeditationCron(config.cron ?? defaults.cron, `${path}.cron`),
  };
}

function validateToolsConfig(
  input: unknown,
  defaults: ToolsConfig,
  providers: Record<string, ProviderConfig>,
): ToolsConfig {
  if (input == null) {
    return {
      web: {
        search: cloneWebToolConfig(defaults.web.search),
        fetch: cloneWebToolConfig(defaults.web.fetch),
      },
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml tools must be a table/object");
  }

  const config = input as ToolsConfigInput;
  assertAllowedKeys(config, new Set(["web"]), "config.toml tools");

  return {
    web: validateWebToolsConfig(config.web, defaults.web, providers),
  };
}

function validateWebToolsConfig(
  input: unknown,
  defaults: WebToolsConfig,
  providers: Record<string, ProviderConfig>,
): WebToolsConfig {
  if (input == null) {
    return {
      search: cloneWebToolConfig(defaults.search),
      fetch: cloneWebToolConfig(defaults.fetch),
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml tools.web must be a table/object");
  }

  const config = input as WebToolsConfigInput;
  assertAllowedKeys(config, new Set(["search", "fetch"]), "config.toml tools.web");

  return {
    search: validateWebToolConfig(config.search, defaults.search, providers, {
      path: "config.toml tools.web.search",
      supportedApis: ["tavily", "brave"],
    }),
    fetch: validateWebToolConfig(config.fetch, defaults.fetch, providers, {
      path: "config.toml tools.web.fetch",
      supportedApis: ["tavily", "firecrawl"],
    }),
  };
}

function validateWebToolConfig(
  input: unknown,
  defaults: WebToolConfig,
  providers: Record<string, ProviderConfig>,
  options: {
    path: string;
    supportedApis: string[];
  },
): WebToolConfig {
  if (input == null) {
    return cloneWebToolConfig(defaults);
  }

  if (!isPlainObject(input)) {
    throw new Error(`${options.path} must be a table/object`);
  }

  const config = input as WebToolConfigInput;
  assertAllowedKeys(config, new Set(["enabled", "provider"]), options.path);

  const enabled = validateOptionalBoolean(
    config.enabled,
    defaults.enabled,
    `${options.path}.enabled`,
  );
  const provider = validateOptionalNonEmptyString(config.provider, `${options.path}.provider`);

  const resolved: WebToolConfig = { enabled };
  if (provider != null) {
    if (!Object.hasOwn(providers, provider)) {
      throw new Error(`${options.path}.provider references unknown provider: ${provider}`);
    }
    const providerApi = providers[provider]?.api;
    if (providerApi == null || !options.supportedApis.includes(providerApi)) {
      throw new Error(
        `${options.path}.provider must reference a provider with api ${options.supportedApis.join(" or ")}`,
      );
    }
    resolved.provider = provider;
  } else if (defaults.provider != null && !enabled) {
    resolved.provider = defaults.provider;
  }

  if (resolved.enabled && resolved.provider == null) {
    throw new Error(`${options.path}.provider is required when enabled = true`);
  }

  return resolved;
}

function validateSecurityConfig(input: unknown, defaults: SecurityConfig): SecurityConfig {
  if (input == null) {
    return {
      filesystem: {
        overrideHardDenyRead: defaults.filesystem.overrideHardDenyRead,
        overrideHardDenyWrite: defaults.filesystem.overrideHardDenyWrite,
        hardDenyRead: [...defaults.filesystem.hardDenyRead],
        hardDenyWrite: [...defaults.filesystem.hardDenyWrite],
      },
      network: {
        overrideHardDenyHosts: defaults.network.overrideHardDenyHosts,
        hardDenyHosts: [...defaults.network.hardDenyHosts],
      },
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml security must be a table/object");
  }

  const config = input as SecurityConfigInput;
  assertAllowedKeys(config, new Set(["filesystem", "network"]), "config.toml security");

  return {
    filesystem: validateSecurityFilesystemConfig(config.filesystem, defaults.filesystem),
    network: validateSecurityNetworkConfig(config.network, defaults.network),
  };
}

function validateChannelsConfig(input: unknown, defaults: ChannelsConfig): ChannelsConfig {
  if (input == null) {
    return {
      lark: {
        installations: Object.fromEntries(
          Object.entries(defaults.lark.installations).map(([key, installation]) => [
            key,
            { ...installation },
          ]),
        ),
      },
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml channels must be a table/object");
  }

  const config = input as ChannelsConfigInput;
  assertAllowedKeys(config, new Set(["lark"]), "config.toml channels");

  return {
    lark: validateLarkChannelConfig(config.lark, defaults.lark),
  };
}

function validateLarkChannelConfig(input: unknown, defaults: LarkChannelConfig): LarkChannelConfig {
  if (input == null) {
    return {
      installations: Object.fromEntries(
        Object.entries(defaults.installations).map(([key, installation]) => [
          key,
          { ...installation },
        ]),
      ),
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml channels.lark must be a table/object");
  }

  const config = input as LarkChannelConfigInput;
  assertAllowedKeys(config, new Set(["installations"]), "config.toml channels.lark");

  if (config.installations == null) {
    return {
      installations: Object.fromEntries(
        Object.entries(defaults.installations).map(([key, installation]) => [
          key,
          { ...installation },
        ]),
      ),
    };
  }

  if (!isPlainObject(config.installations)) {
    throw new Error("config.toml channels.lark.installations must be a table/object");
  }

  const installations: Record<string, LarkInstallationConfig> = {};
  for (const [installationId, rawInstallation] of Object.entries(config.installations)) {
    installations[installationId] = validateLarkInstallationConfig(
      installationId,
      rawInstallation,
      defaults.installations[installationId],
    );
  }

  return { installations };
}

function validateLarkInstallationConfig(
  installationId: string,
  input: unknown,
  defaults?: LarkInstallationConfig,
): LarkInstallationConfig {
  if (!isPlainObject(input)) {
    throw new Error(
      `config.toml channels.lark.installations.${installationId} must be a table/object`,
    );
  }

  const config = input as LarkInstallationConfigInput;
  assertAllowedKeys(
    config,
    new Set(["enabled", "appId", "appSecret", "connectionMode"]),
    `config.toml channels.lark.installations.${installationId}`,
  );

  const resolved: LarkInstallationConfig = {
    enabled: defaults?.enabled ?? true,
    connectionMode: defaults?.connectionMode ?? "websocket",
    ...(defaults?.appId == null ? {} : { appId: defaults.appId }),
    ...(defaults?.appSecret == null ? {} : { appSecret: defaults.appSecret }),
  };

  if (config.enabled != null) {
    resolved.enabled = validateBoolean(
      config.enabled,
      `config.toml channels.lark.installations.${installationId}.enabled`,
    );
  }

  const appId = validateOptionalNonEmptyString(
    config.appId,
    `config.toml channels.lark.installations.${installationId}.appId`,
  );
  if (appId != null) {
    resolved.appId = appId;
  }

  const appSecret = validateOptionalNonEmptyString(
    config.appSecret,
    `config.toml channels.lark.installations.${installationId}.appSecret`,
  );
  if (appSecret != null) {
    resolved.appSecret = appSecret;
  }

  if (config.connectionMode != null) {
    if (
      typeof config.connectionMode !== "string" ||
      !LARK_CONNECTION_MODES.includes(config.connectionMode as LarkConnectionMode)
    ) {
      throw new Error(
        `config.toml channels.lark.installations.${installationId}.connectionMode must be websocket or webhook`,
      );
    }
    resolved.connectionMode = config.connectionMode as LarkConnectionMode;
  }

  return resolved;
}

function validateSecurityFilesystemConfig(
  input: unknown,
  defaults: SecurityFilesystemConfig,
): SecurityFilesystemConfig {
  if (input == null) {
    return {
      overrideHardDenyRead: defaults.overrideHardDenyRead,
      overrideHardDenyWrite: defaults.overrideHardDenyWrite,
      hardDenyRead: [...defaults.hardDenyRead],
      hardDenyWrite: [...defaults.hardDenyWrite],
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml security.filesystem must be a table/object");
  }

  const config = input as SecurityFilesystemConfigInput;
  assertAllowedKeys(
    config,
    new Set(["overrideHardDenyRead", "overrideHardDenyWrite", "hardDenyRead", "hardDenyWrite"]),
    "config.toml security.filesystem",
  );

  return {
    overrideHardDenyRead: validateOptionalBoolean(
      config.overrideHardDenyRead,
      defaults.overrideHardDenyRead,
      "config.toml security.filesystem.overrideHardDenyRead",
    ),
    overrideHardDenyWrite: validateOptionalBoolean(
      config.overrideHardDenyWrite,
      defaults.overrideHardDenyWrite,
      "config.toml security.filesystem.overrideHardDenyWrite",
    ),
    hardDenyRead: validateStringArray(
      config.hardDenyRead,
      defaults.hardDenyRead,
      "config.toml security.filesystem.hardDenyRead",
    ),
    hardDenyWrite: validateStringArray(
      config.hardDenyWrite,
      defaults.hardDenyWrite,
      "config.toml security.filesystem.hardDenyWrite",
    ),
  };
}

function validateSecurityNetworkConfig(
  input: unknown,
  defaults: SecurityNetworkConfig,
): SecurityNetworkConfig {
  if (input == null) {
    return {
      overrideHardDenyHosts: defaults.overrideHardDenyHosts,
      hardDenyHosts: [...defaults.hardDenyHosts],
    };
  }

  if (!isPlainObject(input)) {
    throw new Error("config.toml security.network must be a table/object");
  }

  const config = input as SecurityNetworkConfigInput;
  assertAllowedKeys(
    config,
    new Set(["overrideHardDenyHosts", "hardDenyHosts"]),
    "config.toml security.network",
  );

  return {
    overrideHardDenyHosts: validateOptionalBoolean(
      config.overrideHardDenyHosts,
      defaults.overrideHardDenyHosts,
      "config.toml security.network.overrideHardDenyHosts",
    ),
    hardDenyHosts: validateStringArray(
      config.hardDenyHosts,
      defaults.hardDenyHosts,
      "config.toml security.network.hardDenyHosts",
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

  if (provider.authSource != null) {
    cloned.authSource = provider.authSource;
  }

  return cloned;
}

function cloneWebToolConfig(config: WebToolConfig): WebToolConfig {
  return config.provider == null
    ? { enabled: config.enabled }
    : { enabled: config.enabled, provider: config.provider };
}

function cloneMeditationConfig(config: MeditationConfig): MeditationConfig {
  return {
    enabled: config.enabled,
    cron: config.cron,
  };
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
  };

  if (entry.reasoning != null) {
    cloned.reasoning = { ...entry.reasoning };
  }

  if (entry.pricing != null) {
    cloned.pricing = { ...entry.pricing };
  }

  return cloned;
}

function validateOptionalProviderAuthSource(
  value: unknown,
  path: string,
): ProviderAuthSource | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !PROVIDER_AUTH_SOURCES.includes(value as ProviderAuthSource)) {
    throw new Error(`${path} must be one of: config, codex-local`);
  }
  return value as ProviderAuthSource;
}

function validateReasoningConfig(input: unknown, path: string): ModelReasoningConfig | undefined {
  if (input == null) {
    return undefined;
  }
  if (!isPlainObject(input)) {
    throw new Error(`${path} must be a table/object`);
  }
  const reasoning = input as ModelReasoningConfigInput;
  assertAllowedKeys(reasoning, new Set(["enabled", "effort"]), path);

  const enabled = validateBoolean(reasoning.enabled, `${path}.enabled`);
  const effort = validateOptionalReasoningEffort(reasoning.effort, `${path}.effort`);

  if (!enabled && effort != null) {
    throw new Error(`${path}.effort cannot be set when ${path}.enabled is false`);
  }

  return effort == null ? { enabled } : { enabled, effort };
}

function validateOptionalReasoningEffort(
  value: unknown,
  path: string,
): ReasoningEffort | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    throw new Error(`${path} must be one of: minimal, low, medium, high, xhigh`);
  }
  return value as ReasoningEffort;
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

function validateOptionalBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value == null) {
    return fallback;
  }

  return validateBoolean(value, path);
}

function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }

  return value;
}

function validateMeditationCron(value: unknown, path: string): string {
  const cron = validateNonEmptyString(value, path);
  try {
    computeNextRunAt(
      {
        scheduleKind: "cron",
        scheduleValue: cron,
      },
      new Date(),
    );
  } catch (error) {
    throw new Error(
      error instanceof Error ? `${path} is invalid: ${error.message}` : `${path} is invalid`,
    );
  }

  return cron;
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

function validateStringArray(input: unknown, defaults: string[], path: string): string[] {
  if (input == null) {
    return [...defaults];
  }

  if (!Array.isArray(input)) {
    throw new Error(`${path} must be an array`);
  }

  return input.map((value, index) => validateNonEmptyString(value, `${path}[${index}]`));
}

function validateProjectContextFiles(input: unknown, defaults: string[], path: string): string[] {
  const files = validateStringArray(input, defaults, path);
  const seen = new Set<string>();
  for (const file of files) {
    if (!isSafeProjectContextFileName(file)) {
      throw new Error(`${path} entries must be simple file names without path separators`);
    }
    if (seen.has(file)) {
      throw new Error(`${path} contains duplicate file name: ${file}`);
    }
    seen.add(file);
  }
  return files;
}

function isSafeProjectContextFileName(fileName: string): boolean {
  return (
    fileName !== "." &&
    fileName !== ".." &&
    fileName === pathSafeBasename(fileName) &&
    !fileName.includes("/") &&
    !fileName.includes("\\") &&
    !fileName.includes("\u0000")
  );
}

function pathSafeBasename(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  return normalized.split("/").pop() ?? normalized;
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
