import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentAssistantContentBlock,
  AgentToolResultContentBlock,
} from "@/src/agent/llm/messages.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { loadConfig } from "@/src/config/load.js";
import type { AppConfig } from "@/src/config/schema.js";
import type { MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";

const ENV_FILE_NAME = ".env.integration.local";
const PROVIDER_ID = "integration_primary";
const MODEL_ID = "integration_primary/default";

export interface IntegrationLlmProfile {
  api: string;
  baseUrl?: string;
  apiKey: string;
  upstreamId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export interface IntegrationLlmFixture {
  config: AppConfig;
  models: ProviderRegistry;
  profile: IntegrationLlmProfile;
  tempDir: string;
  cleanup: () => Promise<void>;
}

export async function createIntegrationLlmFixture(): Promise<IntegrationLlmFixture> {
  const profile = await loadRequiredIntegrationLlmProfile();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-llm-integration-"));
  const configPath = path.join(tempDir, "config.toml");
  const secretsPath = path.join(tempDir, "secrets.toml");

  await writeFile(configPath, buildConfigToml(profile), "utf8");
  await writeFile(
    secretsPath,
    ["[llm.integration]", `apiKey = ${toTomlString(profile.apiKey)}`, ""].join("\n"),
    "utf8",
  );

  const config = await loadConfig({
    configTomlPath: configPath,
    secretsTomlPath: secretsPath,
  });

  return {
    config,
    models: new ProviderRegistry(config),
    profile,
    tempDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export function createStoredUserMessage(input: {
  sessionId: string;
  id: string;
  seq: number;
  content: string;
  createdAt: string;
}): Message {
  return {
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    role: "user",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({ content: input.content }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: input.createdAt,
  };
}

export function createStoredAssistantMessage(input: {
  sessionId: string;
  id: string;
  seq: number;
  createdAt: string;
  provider: string;
  model: string;
  modelApi: string;
  stopReason: "stop" | "length" | "toolUse";
  content: AgentAssistantContentBlock[];
  usage?: MessageUsage;
}): Message {
  const usage = input.usage ?? defaultUsage();
  return {
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    role: "assistant",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    provider: input.provider,
    model: input.model,
    modelApi: input.modelApi,
    stopReason: input.stopReason,
    errorMessage: null,
    payloadJson: JSON.stringify({ content: input.content }),
    tokenInput: usage.input,
    tokenOutput: usage.output,
    tokenCacheRead: usage.cacheRead,
    tokenCacheWrite: usage.cacheWrite,
    tokenTotal: usage.totalTokens ?? null,
    usageJson: JSON.stringify(usage),
    createdAt: input.createdAt,
  };
}

export function createStoredToolResultMessage(input: {
  sessionId: string;
  id: string;
  seq: number;
  createdAt: string;
  toolCallId: string;
  toolName: string;
  content: AgentToolResultContentBlock[];
  isError?: boolean;
  details?: unknown;
}): Message {
  return {
    id: input.id,
    sessionId: input.sessionId,
    seq: input.seq,
    role: "tool",
    messageType: "tool_result",
    visibility: "hidden_system",
    channelMessageId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      content: input.content,
      isError: input.isError ?? false,
      ...(input.details !== undefined ? { details: input.details } : {}),
    }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: input.createdAt,
  };
}

export function seedConversationFixture(sql: { exec: (statement: string) => void }): void {
  sql.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-23T00:00:00.000Z', '2026-03-23T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-23T00:00:00.000Z', '2026-03-23T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-23T00:00:00.000Z', '2026-03-23T00:00:00.000Z');
  `);
}

function defaultUsage(): MessageUsage {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

async function loadRequiredIntegrationLlmProfile(): Promise<IntegrationLlmProfile> {
  const envPath = path.resolve(process.cwd(), ENV_FILE_NAME);
  const env = parseEnvFile(await readFile(envPath, "utf8"), envPath);
  const baseUrl = getOptionalEnv(env, "POKECLAW_IT_LLM_BASE_URL");

  return {
    api: getRequiredEnv(env, "POKECLAW_IT_LLM_API"),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    apiKey: getRequiredEnv(env, "POKECLAW_IT_LLM_API_KEY"),
    upstreamId: getRequiredEnv(env, "POKECLAW_IT_LLM_UPSTREAM_ID"),
    contextWindow: getIntegerEnv(env, "POKECLAW_IT_LLM_CONTEXT_WINDOW", 200_000),
    maxOutputTokens: getIntegerEnv(env, "POKECLAW_IT_LLM_MAX_OUTPUT_TOKENS", 16_384),
    supportsTools: getBooleanEnv(env, "POKECLAW_IT_LLM_SUPPORTS_TOOLS", true),
    supportsVision: getBooleanEnv(env, "POKECLAW_IT_LLM_SUPPORTS_VISION", false),
    supportsReasoning: getBooleanEnv(env, "POKECLAW_IT_LLM_SUPPORTS_REASONING", true),
  };
}

function buildConfigToml(profile: IntegrationLlmProfile): string {
  const lines = [
    "[providers.integration_primary]",
    `api = ${toTomlString(profile.api)}`,
    ...(profile.baseUrl ? [`baseUrl = ${toTomlString(profile.baseUrl)}`] : []),
    'apiKey_ref = "secret://llm/integration/apiKey"',
    "",
    "[[models.catalog]]",
    `id = ${toTomlString(MODEL_ID)}`,
    `provider = ${toTomlString(PROVIDER_ID)}`,
    `upstreamId = ${toTomlString(profile.upstreamId)}`,
    `contextWindow = ${profile.contextWindow}`,
    `maxOutputTokens = ${profile.maxOutputTokens}`,
    `supportsTools = ${profile.supportsTools}`,
    `supportsVision = ${profile.supportsVision}`,
    `supportsReasoning = ${profile.supportsReasoning}`,
    "",
    "[models.scenarios]",
    `chat = [${toTomlString(MODEL_ID)}]`,
    `compaction = [${toTomlString(MODEL_ID)}]`,
    `subagent = [${toTomlString(MODEL_ID)}]`,
    `cron = [${toTomlString(MODEL_ID)}]`,
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function parseEnvFile(content: string, filePath: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env line ${index + 1} in ${filePath}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    result[key] = stripQuotes(rawValue);
  }

  return result;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function getRequiredEnv(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required integration env: ${key}`);
  }

  return value;
}

function getOptionalEnv(env: Record<string, string>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function getIntegerEnv(env: Record<string, string>, key: string, fallback: number): number {
  const value = getOptionalEnv(env, key);
  if (value == null) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Integration env ${key} must be a positive integer`);
  }

  return parsed;
}

function getBooleanEnv(env: Record<string, string>, key: string, fallback: boolean): boolean {
  const value = getOptionalEnv(env, key);
  if (value == null) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Integration env ${key} must be "true" or "false"`);
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}
