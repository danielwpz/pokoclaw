import { createLogger } from "@/src/shared/logger.js";
import type { StorageDatabase } from "@/src/storage/db/client.js";
import { openStorageDatabase } from "@/src/storage/db/client.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";

export async function initializeStorageOnStartup(
  databasePath: string = getProductionDatabasePath(),
): Promise<StorageDatabase> {
  const logger = await createLogger({ subsystem: "db" });

  logger.info("Initializing storage database", { databasePath });
  const storage = openStorageDatabase({ databasePath, initializeSchema: true });
  logger.info("Storage database initialized", { databasePath });
  return storage;
}

export async function registerStorageCleanup(storage: StorageDatabase): Promise<void> {
  const logger = await createLogger({ subsystem: "db" });
  let closed = false;

  const closeStorage = (signal: string): void => {
    if (closed) {
      return;
    }

    closed = true;
    try {
      storage.close();
      logger.info("Storage database connection closed", { signal });
    } catch (error) {
      logger.error("Failed to close storage database connection", {
        signal,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  process.once("SIGINT", () => closeStorage("SIGINT"));
  process.once("SIGTERM", () => closeStorage("SIGTERM"));
  process.once("beforeExit", () => closeStorage("beforeExit"));
}

export {
  type OpenStorageDatabaseOptions,
  openStorageDatabase,
  type StorageDatabase,
  type StorageDb,
} from "@/src/storage/db/client.js";
export { getProductionDatabasePath, getTestDatabasePath } from "@/src/storage/db/paths.js";
export { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
export { type AppendMessageInput, MessagesRepo } from "@/src/storage/repos/messages.repo.js";
export { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
export { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
