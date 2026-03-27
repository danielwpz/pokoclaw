import { loadConfig } from "@/src/config/load.js";
import { createRuntimeBootstrap } from "@/src/runtime/bootstrap.js";
import { createBootstrapLogger, createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDatabase } from "@/src/storage/index.js";
import { initializeStorageOnStartup } from "@/src/storage/index.js";

const logger = createSubsystemLogger("main");

export async function main(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.info("starting pokeclaw");

  let storage: StorageDatabase | null = null;
  let runtime: ReturnType<typeof createRuntimeBootstrap> | null = null;

  try {
    const config = await loadConfig();
    logger.info("application config loaded", {
      providers: Object.keys(config.providers).length,
      models: config.models.catalog.length,
    });

    storage = await initializeStorageOnStartup();
    runtime = createRuntimeBootstrap({
      config,
      storage: storage.db,
    });

    runtime.start();
    logger.info("startup complete");

    const signal = await waitForShutdownSignal();
    logger.info("shutdown requested", { signal });

    await runtime.shutdown();
    runtime = null;
    storage.close();
    storage = null;
    logger.info("shutdown complete", { signal });
  } finally {
    if (runtime != null) {
      try {
        await runtime.shutdown();
      } catch {}
    }

    if (storage != null) {
      try {
        storage.close();
      } catch {}
    }
  }
}

main().catch((error: unknown) => {
  const bootstrapLogger = createBootstrapLogger({ subsystem: "bootstrap" });
  bootstrapLogger.error("startup failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const handleSignal = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(signal);
    };

    const onSigint = () => handleSignal("SIGINT");
    const onSigterm = () => handleSignal("SIGTERM");

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}
