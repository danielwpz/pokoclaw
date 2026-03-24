import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import { createEditTool } from "@/src/tools/edit.js";
import type { ToolApprovalRequired, ToolFailure } from "@/src/tools/errors.js";
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

describe("edit tool", () => {
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

  test("edits a granted file with an exact text match", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-edit-tool-"));

    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    const expectedAbsolutePath = await resolveExpectedToolAbsolutePath(filePath);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [
        { kind: "fs.read", path: `${tempDir}/**` },
        { kind: "fs.write", path: `${tempDir}/**` },
      ],
    });

    const registry = new ToolRegistry();
    registry.register(createEditTool());

    const result = await registry.execute(
      "edit",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        path: "notes.txt",
        oldText: "beta",
        newText: "delta",
      },
    );

    expect(await readFile(filePath, "utf8")).toBe("alpha\ndelta\ngamma\n");
    expect(result).toEqual({
      content: [{ type: "text", text: "Edited notes.txt." }],
      details: {
        path: "notes.txt",
        absolutePath: expectedAbsolutePath,
        replacements: 1,
        matchMode: "exact",
      },
    });
  });

  test("rejects ambiguous matches unless replaceAll is enabled", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-edit-tool-"));

    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, "alpha\nbeta\nbeta\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [
        { kind: "fs.read", path: `${tempDir}/**` },
        { kind: "fs.write", path: `${tempDir}/**` },
      ],
    });

    const registry = new ToolRegistry();
    registry.register(createEditTool());

    await expect(
      registry.execute(
        "edit",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          path: "notes.txt",
          oldText: "beta",
          newText: "delta",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "Found 2 matches in notes.txt. Provide more context or set replaceAll=true.",
    } satisfies Partial<ToolFailure>);
  });

  test("denies edits in the system directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-edit-tool-"));

    const registry = new ToolRegistry();
    registry.register(createEditTool());

    await expect(
      registry.execute(
        "edit",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          path: path.join(POKECLAW_SYSTEM_DIR, "config.toml"),
          oldText: "old",
          newText: "new",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: `The read request is blocked by system policy: ${path.join(POKECLAW_SYSTEM_DIR, "config.toml")}`,
    } satisfies Partial<ToolFailure>);
  });

  test("requests both read and write approval together for an ungranted edit", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-edit-tool-"));

    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    const expectedAbsolutePath = await resolveExpectedToolAbsolutePath(filePath);

    const registry = new ToolRegistry();
    registry.register(createEditTool());

    await expect(
      registry.execute(
        "edit",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          path: "notes.txt",
          oldText: "beta",
          newText: "delta",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      request: {
        scopes: [
          { kind: "fs.read", path: expectedAbsolutePath },
          { kind: "fs.write", path: expectedAbsolutePath },
        ],
      },
    } satisfies Partial<ToolApprovalRequired>);
  });
});
