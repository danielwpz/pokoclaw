import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadConfig } from "@/src/config/load.js";
import { resolveConfigRefs, resolveSecretRef } from "@/src/config/refs.js";

describe("config loader", () => {
  test("resolves a secret ref directly", () => {
    expect(
      resolveSecretRef(
        {
          llm: {
            anthropic: {
              apiKey: "secret-value",
            },
          },
        },
        "secret://llm/anthropic/apiKey",
      ),
    ).toBe("secret-value");
  });

  test("resolves config _ref fields into normal fields", () => {
    const resolved = resolveConfigRefs(
      {
        service: {
          apiKey_ref: "secret://llm/anthropic/apiKey",
        },
      },
      {
        llm: {
          anthropic: {
            apiKey: "secret-value",
          },
        },
      },
    );

    expect(resolved).toEqual({
      service: {
        apiKey: "secret-value",
      },
    });
  });

  test("rejects invalid secret ref format", () => {
    expect(() => resolveSecretRef({}, "llm/anthropic/apiKey")).toThrow(
      "Invalid secret ref: llm/anthropic/apiKey",
    );
    expect(() => resolveSecretRef({}, "secret://")).toThrow("Invalid secret ref: secret://");
  });

  test("rejects missing secret ref path", () => {
    expect(() => resolveSecretRef({}, "secret://llm/anthropic/apiKey")).toThrow(
      "Missing secret for ref: secret://llm/anthropic/apiKey",
    );
  });

  test("rejects secret refs that point to tables", () => {
    expect(() =>
      resolveSecretRef(
        {
          llm: {
            anthropic: {
              apiKey: "secret-value",
            },
          },
        },
        "secret://llm/anthropic",
      ),
    ).toThrow("Missing secret for ref: secret://llm/anthropic");
  });

  test("rejects non-string _ref values", () => {
    expect(() =>
      resolveConfigRefs(
        {
          service: {
            apiKey_ref: 123,
          },
        },
        {},
      ),
    ).toThrow("Config ref apiKey_ref must be a string");
  });

  test("rejects configs that contain both field and field_ref", () => {
    expect(() =>
      resolveConfigRefs(
        {
          service: {
            apiKey: "literal",
            apiKey_ref: "secret://llm/anthropic/apiKey",
          },
        },
        {
          llm: {
            anthropic: {
              apiKey: "secret-value",
            },
          },
        },
      ),
    ).toThrow("Config cannot contain both apiKey and apiKey_ref");
  });

  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-config-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("uses defaults when both config files are missing", async () => {
    const config = await loadConfig({
      configTomlPath: path.join(tempDir, "missing-config.toml"),
      secretsTomlPath: path.join(tempDir, "missing-secrets.toml"),
    });

    expect(config.logging.level).toBe("info");
    expect(typeof config.logging.useColors).toBe("boolean");
    expect(config.providers).toEqual({});
    expect(config.models.catalog).toEqual([]);
    expect(config.models.scenarios).toEqual({
      chat: [],
      compaction: [],
      task: [],
      meditationBucket: [],
      meditationConsolidation: [],
    });
    expect(config.compaction).toEqual({
      reserveTokens: 60_000,
      keepRecentTokens: 40_000,
      reserveTokensFloor: 60_000,
      recentTurnsPreserve: 3,
    });
    expect(config.runtime).toEqual({
      maxTurns: 60,
      approvalTimeoutMs: 180_000,
      approvalGrantTtlMs: 604_800_000,
    });
    expect(config.selfHarness).toEqual({
      meditation: {
        enabled: true,
        cron: "0 0 * * *",
      },
    });
    expect(config.tools).toEqual({
      web: {
        search: {
          enabled: false,
        },
        fetch: {
          enabled: false,
        },
      },
    });
    expect(config.security).toEqual({
      filesystem: {
        overrideHardDenyRead: false,
        overrideHardDenyWrite: false,
        hardDenyRead: [],
        hardDenyWrite: [],
      },
      network: {
        overrideHardDenyHosts: false,
        hardDenyHosts: [],
      },
    });
    expect(config.channels).toEqual({
      lark: {
        installations: {},
      },
    });
    expect(config.secrets).toEqual({});
  });

  test("loads config.toml when present", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      ["[logging]", 'level = "debug"', "useColors = false", ""].join("\n"),
      "utf8",
    );

    const config = await loadConfig({ configTomlPath: configPath });

    expect(config.logging.level).toBe("debug");
    expect(config.logging.useColors).toBe(false);
  });

  test("loads provider, model catalog, scenario lists, and compaction config", async () => {
    const configPath = path.join(tempDir, "config.toml");
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(
      configPath,
      [
        "[providers.anthropic_main]",
        'api = "anthropic-messages"',
        'baseUrl = "https://api.anthropic.com"',
        'apiKey_ref = "secret://llm/anthropic/apiKey"',
        "",
        "[providers.openai_main]",
        'api = "openai-responses"',
        "",
        "[providers.tavily]",
        'api = "tavily"',
        'apiKey_ref = "secret://web/tavily/apiKey"',
        "",
        "[[models.catalog]]",
        'id = "anthropic_main/claude-sonnet-4-5"',
        'provider = "anthropic_main"',
        'upstreamId = "claude-sonnet-4-5-20250929"',
        "contextWindow = 200000",
        "maxOutputTokens = 16384",
        "supportsTools = true",
        "supportsVision = true",
        "[models.catalog.reasoning]",
        "enabled = true",
        "[models.catalog.pricing]",
        "input = 3.0",
        "output = 15.0",
        "cacheRead = 0.3",
        "cacheWrite = 3.75",
        "",
        "[[models.catalog]]",
        'id = "openai_main/gpt-5-mini"',
        'provider = "openai_main"',
        'upstreamId = "gpt-5-mini"',
        "contextWindow = 128000",
        "maxOutputTokens = 16384",
        "supportsTools = true",
        "supportsVision = true",
        "[models.catalog.reasoning]",
        "enabled = true",
        "",
        "[models.scenarios]",
        'chat = ["anthropic_main/claude-sonnet-4-5", "openai_main/gpt-5-mini"]',
        'compaction = ["openai_main/gpt-5-mini"]',
        'task = ["anthropic_main/claude-sonnet-4-5"]',
        'meditationBucket = ["openai_main/gpt-5-mini"]',
        'meditationConsolidation = ["anthropic_main/claude-sonnet-4-5"]',
        "",
        "[self-harness.meditation]",
        "enabled = true",
        'cron = "5 0 * * *"',
        "",
        "[tools.web.search]",
        "enabled = true",
        'provider = "tavily"',
        "",
        "[tools.web.fetch]",
        "enabled = true",
        'provider = "tavily"',
        "",
        "[compaction]",
        "reserveTokens = 60000",
        "keepRecentTokens = 40000",
        "reserveTokensFloor = 60000",
        "recentTurnsPreserve = 3",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      secretsPath,
      [
        "[llm.anthropic]",
        'apiKey = "anthropic-secret"',
        "",
        "[web.tavily]",
        'apiKey = "tvly-secret"',
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig({ configTomlPath: configPath, secretsTomlPath: secretsPath });

    expect(config.providers).toEqual({
      anthropic_main: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "anthropic-secret",
      },
      openai_main: {
        api: "openai-responses",
      },
      tavily: {
        api: "tavily",
        apiKey: "tvly-secret",
      },
    });
    expect(config.models.catalog).toHaveLength(2);
    expect(config.models.scenarios.chat).toEqual([
      "anthropic_main/claude-sonnet-4-5",
      "openai_main/gpt-5-mini",
    ]);
    expect(config.models.scenarios.compaction).toEqual(["openai_main/gpt-5-mini"]);
    expect(config.models.scenarios.task).toEqual(["anthropic_main/claude-sonnet-4-5"]);
    expect(config.models.scenarios.meditationBucket).toEqual(["openai_main/gpt-5-mini"]);
    expect(config.models.scenarios.meditationConsolidation).toEqual([
      "anthropic_main/claude-sonnet-4-5",
    ]);
    expect(config.selfHarness).toEqual({
      meditation: {
        enabled: true,
        cron: "5 0 * * *",
      },
    });
    expect(config.compaction.keepRecentTokens).toBe(40_000);
    expect(config.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: "tavily",
        },
        fetch: {
          enabled: true,
          provider: "tavily",
        },
      },
    });
  });

  test("loads secrets.toml when present", async () => {
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(secretsPath, ["[api]", 'key = "secret-value"', ""].join("\n"), "utf8");

    const config = await loadConfig({
      configTomlPath: path.join(tempDir, "missing-config.toml"),
      secretsTomlPath: secretsPath,
    });

    expect(config.secrets).toEqual({
      api: {
        key: "secret-value",
      },
    });
  });

  test("loads security override flags and appended hard deny lists", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[security.filesystem]",
        "overrideHardDenyRead = true",
        'hardDenyRead = ["/Users/example/private/**"]',
        'hardDenyWrite = ["/Users/example/private/**"]',
        "",
        "[security.network]",
        "overrideHardDenyHosts = true",
        'hardDenyHosts = ["internal.example.com"]',
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig({ configTomlPath: configPath });

    expect(config.security).toEqual({
      filesystem: {
        overrideHardDenyRead: true,
        overrideHardDenyWrite: false,
        hardDenyRead: ["/Users/example/private/**"],
        hardDenyWrite: ["/Users/example/private/**"],
      },
      network: {
        overrideHardDenyHosts: true,
        hardDenyHosts: ["internal.example.com"],
      },
    });
  });

  test("loads runtime execution limits", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[runtime]",
        "maxTurns = 24",
        "approvalTimeoutMs = 240000",
        "approvalGrantTtlMs = 172800000",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig({ configTomlPath: configPath });

    expect(config.runtime).toEqual({
      maxTurns: 24,
      approvalTimeoutMs: 240_000,
      approvalGrantTtlMs: 172_800_000,
    });
  });

  test("rejects enabled web tools without a provider", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, ["[tools.web.search]", "enabled = true", ""].join("\n"), "utf8");

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml tools.web.search.provider is required when enabled = true",
    );
  });

  test("rejects web tool providers with unsupported api types", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[providers.openai_main]",
        'api = "openai-responses"',
        "",
        "[tools.web.search]",
        "enabled = true",
        'provider = "openai_main"',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml tools.web.search.provider must reference a provider with api tavily or brave",
    );
  });

  test("loads minimal lark installation config", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[channels.lark.installations.default]",
        "enabled = true",
        'appId = "cli_123"',
        'appSecret = "secret_123"',
        'connectionMode = "websocket"',
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig({ configTomlPath: configPath });

    expect(config.channels.lark.installations).toEqual({
      default: {
        enabled: true,
        appId: "cli_123",
        appSecret: "secret_123",
        connectionMode: "websocket",
      },
    });
  });

  test("rejects invalid lark installation connection mode", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[channels.lark.installations.default]",
        'appId = "cli_123"',
        'appSecret = "secret_123"',
        'connectionMode = "polling"',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml channels.lark.installations.default.connectionMode must be websocket or webhook",
    );
  });

  test("resolves _ref values from config.toml using secrets.toml", async () => {
    const configPath = path.join(tempDir, "config.toml");
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(
      configPath,
      ["[logging]", 'level_ref = "secret://runtime/logLevel"', "useColors = false", ""].join("\n"),
      "utf8",
    );
    await writeFile(secretsPath, ["[runtime]", 'logLevel = "debug"', ""].join("\n"), "utf8");

    const config = await loadConfig({ configTomlPath: configPath, secretsTomlPath: secretsPath });

    expect(config.logging.level).toBe("debug");
    expect(config.logging.useColors).toBe(false);
  });

  test("fails clearly on invalid config TOML syntax", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, '[logging\nlevel = "info"\n', "utf8");

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      `Failed to load TOML file at ${configPath}`,
    );
  });

  test("fails clearly on invalid typed values", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, ["[logging]", 'useColors = "yes"', ""].join("\n"), "utf8");

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml logging.useColors must be a boolean",
    );
  });

  test("rejects unknown top-level config keys", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(configPath, ["[unknown]", "value = 1", ""].join("\n"), "utf8");

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml contains unknown top-level key: unknown",
    );
  });

  test("rejects configs that contain both concrete and _ref fields", async () => {
    const configPath = path.join(tempDir, "config.toml");
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(
      configPath,
      ["[logging]", 'level = "info"', 'level_ref = "secret://runtime/logLevel"', ""].join("\n"),
      "utf8",
    );
    await writeFile(secretsPath, ["[runtime]", 'logLevel = "debug"', ""].join("\n"), "utf8");

    await expect(
      loadConfig({ configTomlPath: configPath, secretsTomlPath: secretsPath }),
    ).rejects.toThrow("Config cannot contain both level and level_ref");
  });

  test("rejects codex-local auth on non-codex providers", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[providers.bad_provider]",
        'api = "anthropic-messages"',
        'authSource = "codex-local"',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      'config.toml providers.bad_provider.authSource = "codex-local" requires api = "openai-codex-responses"',
    );
  });

  test("rejects custom baseUrl for codex-local auth", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[providers.openai_codex]",
        'api = "openai-codex-responses"',
        'authSource = "codex-local"',
        'baseUrl = "https://third-party.example.com"',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      'config.toml providers.openai_codex cannot set baseUrl when authSource = "codex-local"',
    );
  });

  test("rejects legacy subagent model scenario keys", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[providers.main]",
        'api = "openai-responses"',
        "",
        "[[models.catalog]]",
        'id = "gpt5"',
        'provider = "main"',
        'upstreamId = "openai/gpt-5"',
        "contextWindow = 200000",
        "maxOutputTokens = 16384",
        "supportsTools = true",
        "supportsVision = true",
        "",
        "[models.scenarios]",
        'task = ["gpt5"]',
        'subagent = ["gpt5"]',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml models.scenarios contains unknown key: subagent",
    );
  });

  test("rejects legacy cron model scenario keys", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[providers.main]",
        'api = "openai-responses"',
        "",
        "[[models.catalog]]",
        'id = "gpt5"',
        'provider = "main"',
        'upstreamId = "openai/gpt-5"',
        "contextWindow = 200000",
        "maxOutputTokens = 16384",
        "supportsTools = true",
        "supportsVision = true",
        "",
        "[models.scenarios]",
        'task = ["gpt5"]',
        'cron = ["gpt5"]',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml models.scenarios contains unknown key: cron",
    );
  });

  test("rejects model scenarios that reference unknown catalog ids", async () => {
    const configPath = path.join(tempDir, "config.toml");
    await writeFile(
      configPath,
      [
        "[providers.anthropic_main]",
        'api = "anthropic-messages"',
        "",
        "[[models.catalog]]",
        'id = "anthropic_main/claude-sonnet-4-5"',
        'provider = "anthropic_main"',
        'upstreamId = "claude-sonnet-4-5-20250929"',
        "contextWindow = 200000",
        "maxOutputTokens = 16384",
        "supportsTools = true",
        "supportsVision = true",
        "[models.catalog.reasoning]",
        "enabled = true",
        "",
        "[models.scenarios]",
        'chat = ["missing/model"]',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadConfig({ configTomlPath: configPath })).rejects.toThrow(
      "config.toml models.scenarios.chat references unknown model id: missing/model",
    );
  });

  test("rejects non-string and non-table secret values", async () => {
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(secretsPath, ["api_key = 123", ""].join("\n"), "utf8");

    await expect(loadConfig({ secretsTomlPath: secretsPath })).rejects.toThrow(
      "secrets.toml api_key must be a string or table/object",
    );
  });

  test("uses system config paths under pokeclaw home override", async () => {
    const configHome = path.join(tempDir, ".pokeclaw", "system");
    await mkdir(configHome, { recursive: true });
    await writeFile(
      path.join(configHome, "config.toml"),
      ["[logging]", 'level = "warn"', ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(configHome, "secrets.toml"),
      ["[llm.anthropic]", 'apiKey = "secret-value"', ""].join("\n"),
      "utf8",
    );

    const config = await loadConfig({
      configTomlPath: path.join(configHome, "config.toml"),
      secretsTomlPath: path.join(configHome, "secrets.toml"),
    });

    expect(config.logging.level).toBe("warn");
    expect(config.secrets).toEqual({
      llm: {
        anthropic: {
          apiKey: "secret-value",
        },
      },
    });
  });

  test("loads nested secrets for later secret ref resolution", async () => {
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(
      secretsPath,
      ["[llm.anthropic]", '"api-key" = "secret-value"', ""].join("\n"),
      "utf8",
    );

    const config = await loadConfig({
      configTomlPath: path.join(tempDir, "missing-config.toml"),
      secretsTomlPath: secretsPath,
    });

    expect(config.secrets).toEqual({
      llm: {
        anthropic: {
          "api-key": "secret-value",
        },
      },
    });
  });
});
