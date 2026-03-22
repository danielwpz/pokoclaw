import { createBootstrapLogger, createLogger } from "@/src/shared/logger.js";
import { initializeStorageOnStartup, registerStorageCleanup } from "@/src/storage/index.js";

export async function main(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.info("Starting Pokeclaw");

  const logger = await createLogger({ subsystem: "config" });

  logger.info("Loaded application config");

  const storage = await initializeStorageOnStartup();
  await registerStorageCleanup(storage);
}

main().catch((error: unknown) => {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.error("Failed to start Pokeclaw", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
