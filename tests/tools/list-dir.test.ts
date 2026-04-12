import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createListDirTool } from "@/src/tools/list-dir.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import {
  resolveExpectedToolAbsolutePath,
  seedConversationAndAgentFixture,
} from "@/tests/tools/helpers.js";

describe("list_dir tool", () => {
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

  test("lists directory entries with codex-style labels", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));

    const nestedDir = path.join(tempDir, "nested");
    const deeperDir = path.join(nestedDir, "deeper");
    await mkdir(deeperDir, { recursive: true });
    await writeFile(path.join(tempDir, "entry.txt"), "content", "utf8");
    await writeFile(path.join(nestedDir, "child.txt"), "child", "utf8");
    await writeFile(path.join(deeperDir, "grandchild.txt"), "grandchild", "utf8");
    await symlink(path.join(tempDir, "entry.txt"), path.join(tempDir, "link"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createListDirTool());

    const result = await registry.execute(
      "list_dir",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        dir_path: tempDir,
        depth: 3,
        offset: 1,
        limit: 20,
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: [
            `Absolute path: ${await resolveExpectedToolAbsolutePath(tempDir)}`,
            "entry.txt",
            "link@",
            "nested/",
            "  child.txt",
            "  deeper/",
            "    grandchild.txt",
          ].join("\n"),
        },
      ],
      details: {
        dirPath: tempDir,
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        offset: 1,
        limit: 20,
        depth: 3,
        returnedEntries: 6,
        hasMore: false,
      },
    });
  });

  test("respects the depth parameter", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));

    const nestedDir = path.join(tempDir, "nested");
    const deeperDir = path.join(nestedDir, "deeper");
    await mkdir(deeperDir, { recursive: true });
    await writeFile(path.join(tempDir, "root.txt"), "root", "utf8");
    await writeFile(path.join(nestedDir, "child.txt"), "child", "utf8");
    await writeFile(path.join(deeperDir, "grandchild.txt"), "grandchild", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createListDirTool());

    const depthOne = await registry.execute(
      "list_dir",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        dir_path: tempDir,
        depth: 1,
      },
    );

    expect(depthOne.content).toEqual([
      {
        type: "text",
        text: [
          `Absolute path: ${await resolveExpectedToolAbsolutePath(tempDir)}`,
          "nested/",
          "root.txt",
        ].join("\n"),
      },
    ]);
  });

  test("paginates in sorted order", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));

    const dirA = path.join(tempDir, "a");
    const dirB = path.join(tempDir, "b");
    await mkdir(dirA);
    await mkdir(dirB);
    await writeFile(path.join(dirA, "a_child.txt"), "a", "utf8");
    await writeFile(path.join(dirB, "b_child.txt"), "b", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createListDirTool());

    const firstPage = await registry.execute(
      "list_dir",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        dir_path: tempDir,
        depth: 2,
        offset: 1,
        limit: 2,
      },
    );

    const secondPage = await registry.execute(
      "list_dir",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        dir_path: tempDir,
        depth: 2,
        offset: 3,
        limit: 2,
      },
    );

    expect(firstPage.content).toEqual([
      {
        type: "text",
        text: [
          `Absolute path: ${await resolveExpectedToolAbsolutePath(tempDir)}`,
          "a/",
          "  a_child.txt",
          "More than 2 entries found",
        ].join("\n"),
      },
    ]);
    expect(secondPage.content).toEqual([
      {
        type: "text",
        text: [
          `Absolute path: ${await resolveExpectedToolAbsolutePath(tempDir)}`,
          "b/",
          "  b_child.txt",
        ].join("\n"),
      },
    ]);
  });

  test("errors when offset exceeds the visible entry count", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));
    await mkdir(path.join(tempDir, "nested"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createListDirTool());

    await expect(
      registry.execute(
        "list_dir",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          dir_path: tempDir,
          depth: 2,
          offset: 10,
          limit: 1,
        },
      ),
    ).rejects.toMatchObject({
      kind: "recoverable_error",
      message: "offset exceeds directory entry count",
    });
  });

  test("requires an absolute dir_path", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));

    const registry = new ToolRegistry();
    registry.register(createListDirTool());

    await expect(
      registry.execute(
        "list_dir",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          dir_path: ".",
        },
      ),
    ).rejects.toMatchObject({
      kind: "recoverable_error",
      message: "dir_path must be an absolute path",
    });
  });

  test("omits entries outside the granted subtree", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));

    const visibleDir = path.join(tempDir, "visible");
    const hiddenDir = path.join(tempDir, "hidden");
    await mkdir(visibleDir);
    await mkdir(hiddenDir);
    await writeFile(path.join(visibleDir, "ok.txt"), "ok", "utf8");
    await writeFile(path.join(hiddenDir, "secret.txt"), "secret", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${visibleDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createListDirTool());

    const result = await registry.execute(
      "list_dir",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        dir_path: visibleDir,
      },
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          `Absolute path: ${await resolveExpectedToolAbsolutePath(visibleDir)}`,
          "ok.txt",
        ].join("\n"),
      },
    ]);
  });

  test("shows all top-level children when the parent directory is granted exactly", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-list-dir-tool-"));

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
    registry.register(createListDirTool());

    const result = await registry.execute(
      "list_dir",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: chatApiDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        dir_path: tempDir,
        depth: 2,
        offset: 1,
        limit: 20,
      },
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          `Absolute path: ${await resolveExpectedToolAbsolutePath(tempDir)}`,
          "chat-api/",
          "  Cargo.toml",
          "stripe-node/",
        ].join("\n"),
      },
    ]);
  });
});
