import type { RawConfig } from "@/src/config/schema.js";

export const DEFAULT_CONFIG: RawConfig = {
  logging: {
    level: "info",
    useColors: process.stdout.isTTY,
  },
};
