import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LiveConfigManager } from "@/src/config/live-manager.js";
import { loadConfig } from "@/src/config/load.js";
import { ScenarioModelSwitchService } from "@/src/config/scenario-model-switch.js";

async function createConfigWorkspace(): Promise<{
  dir: string;
  configTomlPath: string;
  secretsTomlPath: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-model-switch-"));
  const configTomlPath = path.join(dir, "config.toml");
  const secretsTomlPath = path.join(dir, "secrets.toml");
  await writeFile(configTomlPath, buildConfigToml(), "utf8");
  await writeFile(secretsTomlPath, "", "utf8");
  return {
    dir,
    configTomlPath,
    secretsTomlPath,
  };
}

function buildConfigToml(): string {
  return [
    "# top comment should stay",
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
    "[[models.catalog]]",
    'id = "minimax"',
    'provider = "main"',
    'upstreamId = "minimax/m1"',
    "contextWindow = 128000",
    "maxOutputTokens = 8192",
    "supportsTools = false",
    "supportsVision = false",
    "",
    "[models.scenarios]",
    "# keep this section comment",
    'chat = ["deepseek"] # keep this inline comment',
    'compaction = ["gpt5"]',
    'subagent = ["gpt5"]',
    'cron = ["deepseek"]',
    'meditationBucket = ["gpt5"]',
    'meditationConsolidation = ["gpt5"]',
    "",
  ].join("\n");
}

describe("ScenarioModelSwitchService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  test("moves an already-configured model to the front and reloads the live snapshot", async () => {
    const workspace = await createConfigWorkspace();
    tempDirs.push(workspace.dir);
    const initialSnapshot = await loadConfig(workspace);
    const liveConfig = new LiveConfigManager({
      initialSnapshot,
      filePaths: workspace,
    });
    const service = new ScenarioModelSwitchService(liveConfig);

    const result = await service.switchScenarioModel({
      scenario: "chat",
      modelId: "gpt5",
    });

    expect(result).toMatchObject({
      scenario: "chat",
      previousModelId: "deepseek",
      nextModelId: "gpt5",
      configuredModelIds: ["gpt5", "deepseek"],
      reloaded: true,
      version: 2,
    });
    expect(liveConfig.getSnapshot().models.scenarios.chat).toEqual(["gpt5", "deepseek"]);

    const nextToml = await readFile(workspace.configTomlPath, "utf8");
    expect(nextToml).toContain("# top comment should stay");
    expect(nextToml).toContain("# keep this section comment");
    expect(nextToml).toContain('chat = ["gpt5", "deepseek"] # keep this inline comment');
  });

  test("inserts a catalog model that was not previously configured for the scenario", async () => {
    const workspace = await createConfigWorkspace();
    tempDirs.push(workspace.dir);
    const initialSnapshot = await loadConfig(workspace);
    const liveConfig = new LiveConfigManager({
      initialSnapshot,
      filePaths: workspace,
    });
    const service = new ScenarioModelSwitchService(liveConfig);

    const result = await service.switchScenarioModel({
      scenario: "cron",
      modelId: "minimax",
    });

    expect(result.configuredModelIds).toEqual(["minimax", "deepseek"]);
    expect(result.warnings).toEqual(["该模型不支持 tools，某些依赖工具调用的场景可能受影响。"]);
    expect(liveConfig.getSnapshot().models.scenarios.cron).toEqual(["minimax", "deepseek"]);

    const nextToml = await readFile(workspace.configTomlPath, "utf8");
    expect(nextToml).toContain('cron = ["minimax", "deepseek"]');
  });
});
