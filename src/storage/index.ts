import { createLogger } from "@/src/shared/logger.js";
import { openStorageDatabase } from "@/src/storage/db/client.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";

export async function initializeStorageOnStartup(
  databasePath: string = getProductionDatabasePath(),
): Promise<void> {
  const logger = await createLogger({ subsystem: "db" });

  logger.info("Initializing storage database", { databasePath });
  const storage = openStorageDatabase({ databasePath, initializeSchema: true });
  logger.info("Storage database initialized", { databasePath });
  storage.close();
  logger.info("Storage database connection closed", { databasePath });
}

export {
  type OpenStorageDatabaseOptions,
  openStorageDatabase,
  type StorageDatabase,
  type StorageDb,
} from "@/src/storage/db/client.js";
export { getProductionDatabasePath, getTestDatabasePath } from "@/src/storage/db/paths.js";
export { type AppendMessageInput, MessagesRepo } from "@/src/storage/repos/messages.repo.js";
