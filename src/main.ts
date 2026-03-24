import { createBootstrapLogger, createSubsystemLogger } from "@/src/shared/logger.js";
import { initializeStorageOnStartup, registerStorageCleanup } from "@/src/storage/index.js";

const logger = createSubsystemLogger("main");

export async function main(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.info("starting pokeclaw");

  logger.info("application config loaded");

  const storage = await initializeStorageOnStartup();
  await registerStorageCleanup(storage);
  logger.info("startup complete");
}

main().catch((error: unknown) => {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.error("startup failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
