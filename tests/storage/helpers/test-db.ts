import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { openStorageDatabase, type StorageDatabase } from "@/src/storage/db/client.js";
import { getTestDatabasePath } from "@/src/storage/db/paths.js";

export interface TestDatabaseHandle {
  path: string;
  storage: StorageDatabase;
}

export async function createTestDatabase(testFileId: string): Promise<TestDatabaseHandle> {
  const dbPath = getTestDatabasePath(testFileId);
  await mkdir(path.dirname(dbPath), { recursive: true });

  const storage = openStorageDatabase({ databasePath: dbPath, initializeSchema: true });
  return { path: dbPath, storage };
}

export async function destroyTestDatabase(handle: TestDatabaseHandle): Promise<void> {
  handle.storage.close();
  await rm(handle.path, { force: true });
}
