import type { RawConfig } from "@/src/config/schema.js";

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
      subagent: [],
      cron: [],
    },
  },
  compaction: {
    reserveTokens: 60_000,
    keepRecentTokens: 40_000,
    reserveTokensFloor: 60_000,
    recentTurnsPreserve: 3,
  },
  runtime: {
    maxTurns: 20,
    approvalTimeoutMs: 3 * 60 * 1000,
    approvalGrantTtlMs: 7 * 24 * 60 * 60 * 1000,
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
