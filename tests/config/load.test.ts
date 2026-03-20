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

  test("loads secrets.toml when present", async () => {
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(secretsPath, ["[api]", 'key = "secret-value"', ""].join("\n"), "utf8");

    const config = await loadConfig({ secretsTomlPath: secretsPath });

    expect(config.secrets).toEqual({
      api: {
        key: "secret-value",
      },
    });
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

  test("rejects non-string and non-table secret values", async () => {
    const secretsPath = path.join(tempDir, "secrets.toml");
    await writeFile(secretsPath, ["api_key = 123", ""].join("\n"), "utf8");

    await expect(loadConfig({ secretsTomlPath: secretsPath })).rejects.toThrow(
      "secrets.toml api_key must be a string or table/object",
    );
  });

  test("uses default config paths under home directory override", async () => {
    const configHome = path.join(tempDir, ".pokeclaw");
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

    const config = await loadConfig({ secretsTomlPath: secretsPath });

    expect(config.secrets).toEqual({
      llm: {
        anthropic: {
          "api-key": "secret-value",
        },
      },
    });
  });
});
