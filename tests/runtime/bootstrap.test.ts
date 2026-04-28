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
      maxTurns: 60,
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

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
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
});
