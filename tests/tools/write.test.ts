import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import type { ToolApprovalRequired, ToolFailure } from "@/src/tools/errors.js";
import { ToolRegistry } from "@/src/tools/registry.js";
import { createWriteTool } from "@/src/tools/write.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import {
  resolveExpectedToolAbsolutePath,
  seedConversationAndAgentFixture,
} from "@/tests/tools/helpers.js";

describe("write tool", () => {
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

  test("writes a granted file path and creates parent directories", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-write-tool-"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.write", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createWriteTool());

    const result = await registry.execute(
      "write",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
      },
      {
        path: "nested/output.txt",
        content: "hello world",
      },
    );

    const absolutePath = path.join(tempDir, "nested", "output.txt");
    const expectedAbsolutePath = await resolveExpectedToolAbsolutePath(absolutePath);
    expect(await readFile(absolutePath, "utf8")).toBe("hello world");
    expect(result).toEqual({
      content: [{ type: "text", text: "Wrote 11 bytes to nested/output.txt." }],
      details: {
        path: "nested/output.txt",
        absolutePath: expectedAbsolutePath,
        bytesWritten: 11,
      },
    });
  });

  test("denies writes into the system directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-write-tool-"));

    const registry = new ToolRegistry();
    registry.register(createWriteTool());

    await expect(
      registry.execute(
        "write",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          storage: handle.storage.db,
        },
        {
          path: path.join(POKECLAW_SYSTEM_DIR, "config.toml"),
          content: "unsafe = true",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: `The write request is blocked by system policy: ${path.join(POKECLAW_SYSTEM_DIR, "config.toml")}`,
    } satisfies Partial<ToolFailure>);
  });

  test("denies writes that are outside the current agent grant set", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-write-tool-"));

    const registry = new ToolRegistry();
    registry.register(createWriteTool());

    await expect(
      registry.execute(
        "write",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          storage: handle.storage.db,
        },
        {
          path: "outside.txt",
          content: "blocked",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      reasonText: expect.stringContaining("This tool needs approval to continue:"),
      request: {
        scopes: [
          {
            kind: "fs.write",
            path: await resolveExpectedToolAbsolutePath(path.join(tempDir, "outside.txt")),
          },
        ],
      },
    } satisfies Partial<ToolApprovalRequired>);
  });
});
