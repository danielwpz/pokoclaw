import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { normalizeFilesystemTargetPath } from "@/src/security/permissions.js";
import { executeFullAccessSandboxedBash } from "@/src/security/sandbox.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function seedAgentFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_1', 'lark', 'acct_a', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_1', 'ci_1', 'chat_1', 'dm', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_1', 'conv_1', 'dm_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_main', 'conv_1', 'main', '2026-03-22T00:00:00.000Z');
  `);
}

describe("full-access sandbox runtime", () => {
  let handle: TestDatabaseHandle | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("allows binding a random localhost port in full-access sandbox", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-full-access-sandbox-"));

    const script = [
      'const http = require("node:http");',
      'const server = http.createServer((request, response) => response.end("ok"));',
      'server.on("error", error => { console.error(error.stack || error.message); process.exit(1); });',
      'server.listen(0, "127.0.0.1", () => {',
      "  const address = server.address();",
      '  if (address === null || address === undefined || typeof address === "string" || address.port <= 0) {',
      '    console.error("missing port");',
      "    process.exit(1);",
      "  }",
      '  console.log("listening:" + address.port);',
      "  server.close(() => process.exit(0));",
      "});",
      'setTimeout(() => { console.error("timeout"); process.exit(2); }, 5000).unref();',
    ].join(" ");

    const result = await executeFullAccessSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_main",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command: `node -e '${script}'`,
      cwd: tempDir,
      timeoutMs: 10_000,
    });

    expect(result.cwd).toBe(normalizeFilesystemTargetPath(tempDir));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^listening:\d+\n$/);
  });
});
