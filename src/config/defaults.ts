import type { RawConfig } from "@/src/config/schema.js";

export const DEFAULT_RUNTIME_MAX_TURNS = 60;
export const DEFAULT_RUNTIME_APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_RUNTIME_APPROVAL_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_CONFIG: RawConfig = {
  logging: {
    level: "info",
    useColors: Boolean(process.stdout.isTTY),
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
    maxTurns: DEFAULT_RUNTIME_MAX_TURNS,
    approvalTimeoutMs: DEFAULT_RUNTIME_APPROVAL_TIMEOUT_MS,
    approvalGrantTtlMs: DEFAULT_RUNTIME_APPROVAL_GRANT_TTL_MS,
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
};
