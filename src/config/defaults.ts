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
};
