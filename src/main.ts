import { createBootstrapLogger, createLogger } from "@/src/shared/logger.js";
import { initializeStorageOnStartup } from "@/src/storage/index.js";

export async function main(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.info("Starting Pokeclaw");

  const logger = await createLogger({ subsystem: "config" });

  logger.info("Loaded application config");

  await initializeStorageOnStartup();
}

main().catch((error: unknown) => {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.error("Failed to start Pokeclaw", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
