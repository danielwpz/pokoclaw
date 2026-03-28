import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createFindTool } from "@/src/tools/find.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import {
  resolveExpectedToolAbsolutePath,
  seedConversationAndAgentFixture,
} from "@/tests/tools/helpers.js";

describe("find tool", () => {
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

  test("finds matching files and directories inside a granted subtree", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-tool-"));

    await mkdir(path.join(tempDir, "src"));
    await mkdir(path.join(tempDir, "docs"));
    await writeFile(path.join(tempDir, "README.md"), "root", "utf8");
    await writeFile(path.join(tempDir, "src", "index.ts"), "export {};", "utf8");
    await writeFile(path.join(tempDir, "src", "notes.md"), "notes", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createFindTool());

    const result = await registry.execute(
      "find",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        pattern: "*.md",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "README.md\nsrc/notes.md" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        pattern: "*.md",
        type: "any",
        matches: 2,
        visitedEntries: 5,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("filters matches by directory type and respects the result limit", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-tool-"));

    await mkdir(path.join(tempDir, "docs"));
    await mkdir(path.join(tempDir, "src"));
    await mkdir(path.join(tempDir, "tests"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createFindTool());

    const result = await registry.execute(
      "find",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        type: "directory",
        limit: 2,
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "docs/\nsrc/\n\n(2 matches shown. Narrow the pattern or increase limit for more.)",
        },
      ],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        pattern: "*",
        type: "directory",
        matches: 2,
        visitedEntries: 3,
        limit: 2,
        limitReached: true,
      },
    });
  });

  test("skips unreadable symlink targets outside the grant boundary", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-tool-"));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-outside-"));

    await mkdir(path.join(tempDir, "inside"));
    await writeFile(path.join(tempDir, "inside", "visible.txt"), "ok", "utf8");
    await writeFile(path.join(outsideDir, "secret.txt"), "hidden", "utf8");
    await symlink(outsideDir, path.join(tempDir, "outside-link"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createFindTool());

    const result = await registry.execute(
      "find",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        pattern: "*.txt",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "inside/visible.txt" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        pattern: "*.txt",
        type: "any",
        matches: 1,
        visitedEntries: 2,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("continues broad scans but reports unreadable directories as warnings", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-tool-"));

    const readableDir = path.join(tempDir, "inside");
    const unreadableDir = path.join(tempDir, "private");
    await mkdir(readableDir);
    await mkdir(unreadableDir);
    await writeFile(path.join(readableDir, "visible.txt"), "ok", "utf8");
    await writeFile(path.join(unreadableDir, "secret.txt"), "hidden", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createFindTool());

    await chmod(unreadableDir, 0o000);
    try {
      const result = await registry.execute(
        "find",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          pattern: "*.txt",
        },
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("inside/visible.txt"),
        },
      ]);
      expect((result.content[0] as { type: string; text: string }).text).toContain(
        "Warning: skipped 1 unreadable directory:",
      );
      expect((result.content[0] as { type: string; text: string }).text).toContain("private");
      expect(result.details).toMatchObject({
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        pattern: "*.txt",
        type: "any",
        matches: 1,
        visitedEntries: 3,
        limit: 200,
        limitReached: false,
        warnings: [
          {
            path: "private",
            errorCode: expect.stringMatching(/^(EPERM|EACCES)$/),
            errorMessage: expect.stringContaining("private"),
          },
        ],
      });
    } finally {
      await chmod(unreadableDir, 0o755);
    }
  });

  test("fails when the explicitly requested root directory is unreadable", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-tool-"));

    const unreadableRoot = path.join(tempDir, "private");
    await mkdir(unreadableRoot);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createFindTool());

    await chmod(unreadableRoot, 0o000);
    try {
      await expect(
        registry.execute(
          "find",
          {
            sessionId: "sess_1",
            conversationId: "conv_1",
            ownerAgentId: "agent_1",
            cwd: tempDir,
            securityConfig: DEFAULT_CONFIG.security,
            storage: handle.storage.db,
          },
          {
            path: unreadableRoot,
            pattern: "*.txt",
          },
        ),
      ).rejects.toMatchObject({
        name: "ToolFailure",
        kind: "recoverable_error",
        message: expect.stringContaining("Cannot read directory:"),
        details: {
          code: "path_not_readable",
          path: expect.stringContaining("/private"),
        },
      } satisfies Partial<ToolFailure>);
    } finally {
      await chmod(unreadableRoot, 0o755);
    }
  });

  test("denies searching the system directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-find-tool-"));

    const registry = new ToolRegistry();
    registry.register(createFindTool());

    await expect(
      registry.execute(
        "find",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          path: POKECLAW_SYSTEM_DIR,
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
            path: POKECLAW_SYSTEM_DIR,
            scope: "exact",
            access: "read",
          },
        ],
      },
    } satisfies Partial<ToolFailure>);
  });
});
