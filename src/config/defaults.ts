import type { RawConfig } from "@/src/config/schema.js";

export const DEFAULT_CONFIG: RawConfig = {
  logging: {
    level: "info",
    useColors: Boolean(process.stdout.isTTY),
  },
};
