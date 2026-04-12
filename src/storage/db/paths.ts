import path from "node:path";

import { POKOCLAW_SYSTEM_DIR } from "@/src/shared/paths.js";

export const PRODUCTION_DB_BASENAME = "pokoclaw.db";

export function getProductionDatabasePath(): string {
  return path.join(POKOCLAW_SYSTEM_DIR, PRODUCTION_DB_BASENAME);
}

function sanitizePathPart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getTestDatabasePath(testFileId: string, cwd: string = process.cwd()): string {
  const testDbDir = path.join(cwd, ".tmp", "test-db");
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const fileBase = sanitizePathPart(path.basename(testFileId, path.extname(testFileId)));

  return path.join(testDbDir, `${fileBase}-${randomSuffix}.db`);
}
