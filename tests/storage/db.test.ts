import { describe, expect, test } from "vitest";

import { getProductionDatabasePath } from "@/src/storage/db/paths.js";
import { createTestDatabase, destroyTestDatabase } from "@/tests/storage/helpers/test-db.js";

describe("storage db bootstrap", () => {
  test("uses ~/.pokeclaw/workspace/pokeclaw.db as production path", () => {
    const productionPath = getProductionDatabasePath();
    expect(productionPath.endsWith("/.pokeclaw/workspace/pokeclaw.db")).toBe(true);
  });

  test("initializes all core tables on open", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      const rows = handle.storage.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
        )
        .all() as Array<{ name: string }>;
      const tableNames = rows.map((row) => row.name);

      expect(tableNames).toContain("channel_instances");
      expect(tableNames).toContain("conversations");
      expect(tableNames).toContain("conversation_branches");
      expect(tableNames).toContain("agents");
      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("cron_jobs");
      expect(tableNames).toContain("task_runs");
      expect(tableNames).toContain("approval_ledger");
      expect(tableNames).toContain("agent_permission_grants");
      expect(tableNames).toContain("auth_events");
    } finally {
      await destroyTestDatabase(handle);
    }
  });

  test("db-level timestamp CHECK rejects invalid timestamp text", async () => {
    const handle = await createTestDatabase(import.meta.url);

    try {
      expect(() =>
        handle.storage.sqlite
          .prepare(
            "INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            "ci_bad_time",
            "lark",
            "acct_bad",
            "2026/03/22 09:00:00",
            "2026-03-22T09:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      await destroyTestDatabase(handle);
    }
  });
});
