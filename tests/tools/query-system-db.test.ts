import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createQuerySystemDbTool } from "@/src/tools/query-system-db.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

describe("query_system_db tool", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("returns structured rows from the system database", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "db.read", database: "system" }],
    });

    const registry = new ToolRegistry();
    registry.register(createQuerySystemDbTool());
    const result = await registry.execute(
      "query_system_db",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        systemDatabasePath: handle.path,
      },
      {
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents'",
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "json",
          json: {
            columns: ["name"],
            rows: [{ name: "agents" }],
            rowCount: 1,
            returnedRowCount: 1,
            truncated: false,
          },
        },
      ],
    });
  });

  test("uses a read-only database connection for execution", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "db.read", database: "system" }],
    });

    const registry = new ToolRegistry();
    registry.register(createQuerySystemDbTool());

    await expect(
      registry.execute(
        "query_system_db",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          systemDatabasePath: handle.path,
        },
        {
          sql: `
            INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
            VALUES ('ci_readonly', 'lark', 'acct_ro', '2026-04-02T00:00:00.000Z', '2026-04-02T00:00:00.000Z')
          `,
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: expect.stringContaining("System DB query failed:"),
    } satisfies Partial<ToolFailure>);

    const row = handle.storage.sqlite
      .prepare("SELECT id FROM channel_instances WHERE id = ?")
      .get("ci_readonly");
    expect(row).toBeUndefined();
  });
});
