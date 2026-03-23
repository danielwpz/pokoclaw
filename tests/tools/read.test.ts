import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { SecurityService } from "@/src/security/service.js";
import { createTestLogger } from "@/src/shared/logger.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import type { ToolApprovalRequired, ToolFailure } from "@/src/tools/errors.js";
import { createReadTool } from "@/src/tools/read.js";
import { ToolRegistry } from "@/src/tools/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import {
  resolveExpectedToolAbsolutePath,
  seedConversationAndAgentFixture,
} from "@/tests/tools/helpers.js";

describe("read tool", () => {
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

  test("reads a granted file with numbered lines and pagination details", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-read-tool-"));

    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    const expectedAbsolutePath = await resolveExpectedToolAbsolutePath(filePath);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createReadTool());
    const result = await registry.execute(
      "read",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
        logger: createTestLogger(
          { level: "debug", useColors: false },
          { subsystem: "read-tool-test" },
        ),
      },
      { path: "notes.txt", offset: 2, limit: 2 },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "2| beta\n3| gamma\n\n(End of file. 3 lines total.)",
        },
      ],
      details: {
        path: "notes.txt",
        absolutePath: expectedAbsolutePath,
        offset: 2,
        limit: 2,
        totalLines: 3,
        endLine: 3,
      },
    });
  });

  test("fails clearly when owner agent context is missing", async () => {
    handle = await createTestDatabase(import.meta.url);

    const registry = new ToolRegistry();
    registry.register(createReadTool());

    await expect(
      registry.execute(
        "read",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          storage: handle.storage.db,
          logger: createTestLogger(
            { level: "debug", useColors: false },
            { subsystem: "read-tool-test" },
          ),
        },
        { path: "/tmp/example.txt" },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message:
        "This tool call is missing its owner agent context, so the permission check cannot run.",
    } satisfies Partial<ToolFailure>);
  });

  test("denies reads from the system directory before touching the filesystem", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-read-tool-"));

    const registry = new ToolRegistry();
    registry.register(createReadTool());

    await expect(
      registry.execute(
        "read",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          storage: handle.storage.db,
          logger: createTestLogger(
            { level: "debug", useColors: false },
            { subsystem: "read-tool-test" },
          ),
        },
        { path: path.join(POKECLAW_SYSTEM_DIR, "config.toml") },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: `The read request is blocked by system policy: ${path.join(POKECLAW_SYSTEM_DIR, "config.toml")}`,
    } satisfies Partial<ToolFailure>);
  });

  test("denies reads that are outside the current agent grant set", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-read-tool-"));

    await writeFile(path.join(tempDir, "private.txt"), "secret", "utf8");

    const registry = new ToolRegistry();
    registry.register(createReadTool());

    await expect(
      registry.execute(
        "read",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          storage: handle.storage.db,
          logger: createTestLogger(
            { level: "debug", useColors: false },
            { subsystem: "read-tool-test" },
          ),
        },
        { path: "private.txt" },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      reasonText: expect.stringContaining("This tool needs approval to continue:"),
      request: {
        scopes: [
          {
            kind: "fs.read",
            path: await resolveExpectedToolAbsolutePath(path.join(tempDir, "private.txt")),
          },
        ],
      },
    } satisfies Partial<ToolApprovalRequired>);
  });
});
