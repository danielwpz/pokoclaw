import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { POKOCLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createLsTool } from "@/src/tools/ls.js";
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-ls-tool-"));

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
        securityConfig: DEFAULT_CONFIG.security,
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-ls-tool-"));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-ls-outside-"));

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
        securityConfig: DEFAULT_CONFIG.security,
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

  test("shows all direct children when the parent directory itself is granted exactly", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-ls-tool-"));

    const chatApiDir = path.join(tempDir, "chat-api");
    const stripeNodeDir = path.join(tempDir, "stripe-node");
    await mkdir(chatApiDir);
    await mkdir(stripeNodeDir);
    await writeFile(path.join(chatApiDir, "Cargo.toml"), "workspace", "utf8");
    await writeFile(path.join(stripeNodeDir, "package.json"), "{}", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [
        { kind: "fs.read", path: tempDir },
        { kind: "fs.read", path: `${chatApiDir}/**` },
      ],
    });

    const registry = new ToolRegistry();
    registry.register(createLsTool());

    const result = await registry.execute(
      "ls",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: chatApiDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        path: tempDir,
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "chat-api/\nstripe-node/" }],
      details: {
        path: tempDir,
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        visibleEntries: 2,
        totalEntries: 2,
        entryLimitReached: false,
      },
    });
  });

  test("denies listing the system directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-ls-tool-"));

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
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          path: POKOCLAW_SYSTEM_DIR,
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: false,
        entries: [
          {
            resource: "filesystem",
            path: POKOCLAW_SYSTEM_DIR,
            scope: "exact",
            access: "read",
          },
        ],
      },
    } satisfies Partial<ToolFailure>);
  });

  test("recommends subtree read when listing an ungranted directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-ls-tool-"));
    await mkdir(path.join(tempDir, "src"), { recursive: true });

    const registry = new ToolRegistry();
    registry.register(createLsTool());

    await expect(
      registry.execute(
        "ls",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: path.join(tempDir, "src"),
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          path: tempDir,
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: true,
        entries: [
          {
            resource: "filesystem",
            path: await resolveExpectedToolAbsolutePath(tempDir),
            scope: "subtree",
            access: "read",
          },
        ],
      },
    } satisfies Partial<ToolFailure>);
  });
});
