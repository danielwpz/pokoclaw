import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LiveConfigManager } from "@/src/config/live-manager.js";
import { loadConfig } from "@/src/config/load.js";

function buildConfigToml(chatModelId: string): string {
  return [
    "[logging]",
    'level = "info"',
    "useColors = false",
    "",
    "[providers.main]",
    'api = "openai-responses"',
    'apiKey = "test-key"',
    "",
    "[[models.catalog]]",
    'id = "gpt5"',
    'provider = "main"',
    'upstreamId = "openai/gpt-5"',
    "contextWindow = 200000",
    "maxOutputTokens = 8192",
    "supportsTools = true",
    "supportsVision = false",
    "",
    "[[models.catalog]]",
    'id = "deepseek"',
    'provider = "main"',
    'upstreamId = "deepseek/chat"',
    "contextWindow = 128000",
    "maxOutputTokens = 8192",
    "supportsTools = true",
    "supportsVision = false",
    "",
    "[models.scenarios]",
    `chat = ["${chatModelId}"]`,
    'compaction = ["gpt5"]',
    'task = ["gpt5"]',
    'meditationBucket = ["gpt5"]',
    'meditationConsolidation = ["gpt5"]',
    "",
  ].join("\n");
}

function buildLegacyConfigToml(): string {
  return [
    "[logging]",
    'level = "info"',
    "useColors = false",
    "",
    "[providers.main]",
    'api = "openai-responses"',
    'apiKey = "test-key"',
    "",
    "[[models.catalog]]",
    'id = "gpt5"',
    'provider = "main"',
    'upstreamId = "openai/gpt-5"',
    "contextWindow = 200000",
    "maxOutputTokens = 8192",
    "supportsTools = true",
    "supportsVision = false",
    "",
    "[[models.catalog]]",
    'id = "deepseek"',
    'provider = "main"',
    'upstreamId = "deepseek/chat"',
    "contextWindow = 128000",
    "maxOutputTokens = 8192",
    "supportsTools = true",
    "supportsVision = false",
    "",
    "[models.scenarios]",
    'chat = ["deepseek"]',
    'compaction = ["gpt5"]',
    'subagent = ["gpt5"]',
    'cron = ["deepseek"]',
    'meditationBucket = ["gpt5"]',
    'meditationConsolidation = ["gpt5"]',
    "",
  ].join("\n");
}

describe("LiveConfigManager", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  test("reloadFromDisk replaces the active snapshot and notifies subscribers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-live-config-"));
    tempDirs.push(dir);
    const configTomlPath = path.join(dir, "config.toml");
    const secretsTomlPath = path.join(dir, "secrets.toml");
    await writeFile(configTomlPath, buildConfigToml("deepseek"), "utf8");
    await writeFile(secretsTomlPath, "", "utf8");

    const initialSnapshot = await loadConfig({
      configTomlPath,
      secretsTomlPath,
    });
    const manager = new LiveConfigManager({
      initialSnapshot,
      filePaths: {
        configTomlPath,
        secretsTomlPath,
      },
    });
    const listener = vi.fn();
    manager.subscribe(listener);

    await writeFile(configTomlPath, buildConfigToml("gpt5"), "utf8");
    const result = await manager.reloadFromDisk("test_reload");

    expect(result).toEqual({
      reloaded: true,
      version: 2,
      reason: "test_reload",
    });
    expect(manager.getVersion()).toBe(2);
    expect(manager.getSnapshot().models.scenarios.chat).toEqual(["gpt5"]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      version: 2,
      reason: "test_reload",
    });
  });

  test("reloadFromDisk keeps the previous snapshot when the updated file uses legacy scenario keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-live-config-"));
    tempDirs.push(dir);
    const configTomlPath = path.join(dir, "config.toml");
    const secretsTomlPath = path.join(dir, "secrets.toml");
    await writeFile(configTomlPath, buildConfigToml("deepseek"), "utf8");
    await writeFile(secretsTomlPath, "", "utf8");

    const initialSnapshot = await loadConfig({
      configTomlPath,
      secretsTomlPath,
    });
    const manager = new LiveConfigManager({
      initialSnapshot,
      filePaths: {
        configTomlPath,
        secretsTomlPath,
      },
    });

    await writeFile(configTomlPath, buildLegacyConfigToml(), "utf8");

    await expect(manager.reloadFromDisk("legacy_schema")).rejects.toThrow(
      "config.toml models.scenarios contains unknown key: subagent",
    );
    expect(manager.getVersion()).toBe(1);
    expect(manager.getSnapshot().models.scenarios.chat).toEqual(["deepseek"]);
    expect(manager.getSnapshot().models.scenarios.task).toEqual(["gpt5"]);
  });
});
