import { homedir } from "node:os";
import path from "node:path";

export const POKECLAW_HOME_DIR = path.join(homedir(), ".pokeclaw");
export const POKECLAW_WORKSPACE_DIR = path.join(POKECLAW_HOME_DIR, "workspace");
export const PRODUCTION_DB_BASENAME = "pokeclaw.db";

export function getProductionDatabasePath(): string {
  return path.join(POKECLAW_WORKSPACE_DIR, PRODUCTION_DB_BASENAME);
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
