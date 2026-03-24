import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import type { ToolFailure } from "@/src/tools/errors.js";
import { createLsTool } from "@/src/tools/ls.js";
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

describe("ls tool", () => {
  let handle: TestDatabaseHandle | null = null;
  let tempDir: string | null = null;
  let outsideDir: string | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (outsideDir != null) {
      await rm(outsideDir, { recursive: true, force: true });
      outsideDir = null;
    }
  });

  test("lists a granted directory and marks directories with a trailing slash", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-ls-tool-"));

    await writeFile(path.join(tempDir, "b.txt"), "b", "utf8");
    await mkdir(path.join(tempDir, "a-dir"));
    await writeFile(path.join(tempDir, ".hidden"), "hidden", "utf8");
    const expectedAbsolutePath = await resolveExpectedToolAbsolutePath(tempDir);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createLsTool());

    const result = await registry.execute(
      "ls",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
      },
      {},
    );

    expect(result).toEqual({
      content: [{ type: "text", text: ".hidden\na-dir/\nb.txt" }],
      details: {
        path: ".",
        absolutePath: expectedAbsolutePath,
        visibleEntries: 3,
        totalEntries: 3,
        entryLimitReached: false,
      },
    });
  });

  test("filters out unreadable symlink targets from a granted directory listing", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-ls-tool-"));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-ls-outside-"));

    await writeFile(path.join(tempDir, "visible.txt"), "ok", "utf8");
    const deniedLinkPath = path.join(tempDir, "system-link");
    await writeFile(path.join(outsideDir, "secret.txt"), "hidden", "utf8");
    await symlink(outsideDir, deniedLinkPath);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createLsTool());

    const result = await registry.execute(
      "ls",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
      },
      {},
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "visible.txt" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        visibleEntries: 1,
        totalEntries: 1,
        entryLimitReached: false,
      },
    });
  });

  test("denies listing the system directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-ls-tool-"));

    const registry = new ToolRegistry();
    registry.register(createLsTool());

    await expect(
      registry.execute(
        "ls",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          storage: handle.storage.db,
        },
        {
          path: POKECLAW_SYSTEM_DIR,
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: `The read request is blocked by system policy: ${POKECLAW_SYSTEM_DIR}`,
    } satisfies Partial<ToolFailure>);
  });
});
