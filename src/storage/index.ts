import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDatabase } from "@/src/storage/db/client.js";
import { openStorageDatabase } from "@/src/storage/db/client.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";

const logger = createSubsystemLogger("storage");

export async function initializeStorageOnStartup(
  databasePath: string = getProductionDatabasePath(),
): Promise<StorageDatabase> {
  logger.info("opening storage database", { databasePath });
  const storage = openStorageDatabase({ databasePath, initializeSchema: true });
  logger.info("storage database ready", { databasePath });
  return storage;
}

export async function registerStorageCleanup(storage: StorageDatabase): Promise<void> {
  let closed = false;

  const closeStorage = (signal: string): void => {
    if (closed) {
      return;
    }

    closed = true;
    try {
      storage.close();
      logger.info("storage database closed", { signal });
    } catch (error) {
      logger.error("storage database close failed", {
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
export { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
export { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
export { ChannelInstancesRepo } from "@/src/storage/repos/channel-instances.repo.js";
export { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
export { CronJobsRepo } from "@/src/storage/repos/cron-jobs.repo.js";
export { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
export { type AppendMessageInput, MessagesRepo } from "@/src/storage/repos/messages.repo.js";
export { PermissionGrantsRepo } from "@/src/storage/repos/permission-grants.repo.js";
export { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
export { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
