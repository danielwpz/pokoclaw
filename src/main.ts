import { loadConfig } from "@/src/config/load.js";
import { createBootstrapLogger, createLogger } from "@/src/shared/logger.js";

export async function main(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.info("Starting Pokeclaw");

  const config = await loadConfig();
  const logger = createLogger(config.logging, { subsystem: "config" });

  logger.info("Loaded application config");
}

main().catch((error: unknown) => {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.error("Failed to start Pokeclaw", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
