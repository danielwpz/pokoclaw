import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppConfig } from "@/src/config/schema.js";
import { createRuntimeBootstrap } from "@/src/runtime/bootstrap.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function createConfig(): AppConfig {
  return {
    logging: {
      level: "info",
      useColors: false,
    },
    providers: {},
    models: {
      catalog: [],
      scenarios: {
        chat: [],
        compaction: [],
        task: [],
        meditationBucket: [],
        meditationConsolidation: [],
      },
    },
    compaction: {
      reserveTokens: 60_000,
      keepRecentTokens: 40_000,
      reserveTokensFloor: 60_000,
      recentTurnsPreserve: 3,
    },
    runtime: {
      maxTurns: 100,
      maxEmptyOutputLlmAttempts: 5,
      llmFirstResponseTimeoutMs: 45_000,
      approvalTimeoutMs: 180_000,
      approvalGrantTtlMs: 604_800_000,
      autopilot: false,
    },
    projectContext: {
      enabled: true,
      maxBytes: 8192,
      files: ["AGENTS.md", "CLAUDE.md"],
    },
    selfHarness: {
      meditation: {
        enabled: true,
        cron: "0 0 * * *",
      },
    },
    tools: {
      web: {
        search: {
          enabled: false,
        },
        fetch: {
          enabled: false,
        },
      },
    },
    mcp: {
      enabled: false,
      catalogTtlMs: 86_400_000,
      startupTimeoutMs: 30_000,
      toolTimeoutMs: 120_000,
      failureWindowMs: 300_000,
      degradeAfterConsecutiveFailures: 3,
      failStartupOnRequired: false,
      servers: {},
    },
    security: {
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
    },
    channels: {
      lark: {
        installations: {},
      },
    },
    secrets: {},
  };
}

describe("runtime bootstrap", () => {
  let handle: TestDatabaseHandle | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("starts cron, attaches orchestration, and shuts down cleanly", async () => {
    handle = await createTestDatabase(import.meta.url);

    const bootstrap = createRuntimeBootstrap({
      config: createConfig(),
      storage: handle.storage.db,
    });

    bootstrap.start();
    bootstrap.start();

    expect(bootstrap.cron.status()).toMatchObject({
      started: true,
    });
    expect(bootstrap.meditation.status()).toMatchObject({
      started: true,
    });
    expect(bootstrap.heartbeat.status()).toMatchObject({
      started: true,
      subscriberCount: 2,
    });
    expect(bootstrap.lark.status()).toMatchObject({
      started: true,
      enabledInstallations: 0,
      configuredInstallations: 0,
    });

    await expect(
      bootstrap.bridge.runtimeControl.runCronJobNow?.({
        jobId: "missing_cron_job",
      }),
    ).rejects.toThrow("already running or does not exist");

    await bootstrap.shutdown();
    await bootstrap.shutdown();

    expect(bootstrap.cron.status()).toMatchObject({
      started: false,
      inFlightRuns: 0,
    });
    expect(bootstrap.meditation.status()).toMatchObject({
      started: false,
      inFlightRuns: 0,
    });
    expect(bootstrap.heartbeat.status()).toMatchObject({
      started: false,
      subscriberCount: 2,
    });
    expect(bootstrap.lark.status()).toMatchObject({
      started: false,
    });
  });

  test("does not reload MCP when live config changes outside the MCP section", async () => {
    handle = await createTestDatabase(import.meta.url);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-bootstrap-"));
    const configTomlPath = path.join(tempDir, "config.toml");
    const secretsTomlPath = path.join(tempDir, "secrets.toml");
    await writeFile(configTomlPath, "[runtime]\nmaxTurns = 61\n");
    await writeFile(secretsTomlPath, "");

    const bootstrap = createRuntimeBootstrap({
      config: createConfig(),
      storage: handle.storage.db,
      configPaths: {
        configTomlPath,
        secretsTomlPath,
      },
    });

    bootstrap.start();
    const generationBefore = bootstrap.mcp.getStatusSnapshot().generation;

    await bootstrap.liveConfig.reloadFromDisk("test_non_mcp_reload");
    await new Promise((resolve) => setImmediate(resolve));

    expect(bootstrap.liveConfig.getVersion()).toBe(2);
    expect(bootstrap.mcp.getStatusSnapshot().generation).toBe(generationBefore);

    await bootstrap.shutdown();
  });

  test("rejects startup when a required MCP server fails to start", async () => {
    handle = await createTestDatabase(import.meta.url);
    const config = createConfig();
    config.mcp = {
      ...config.mcp,
      enabled: true,
      failStartupOnRequired: true,
      servers: {
        missing: {
          enabled: true,
          transport: "stdio",
          toolPolicy: "ask",
          startupTimeoutMs: 1_000,
          toolTimeoutMs: 120_000,
          catalogTtlMs: 86_400_000,
          failureWindowMs: 300_000,
          degradeAfterConsecutiveFailures: 3,
          failStartupOnRequired: false,
          command: "/path/to/missing-mcp-server",
          args: [],
          env: {},
        },
      },
    };

    const bootstrap = createRuntimeBootstrap({
      config,
      storage: handle.storage.db,
    });

    await expect(bootstrap.start()).rejects.toThrow("MCP server missing failed to start");
    await bootstrap.shutdown();
  });
});
