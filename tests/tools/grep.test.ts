import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import type { ToolFailure } from "@/src/tools/errors.js";
import { createGrepTool } from "@/src/tools/grep.js";
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

describe("grep tool", () => {
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

  test("searches a granted directory tree and returns matching lines", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await mkdir(path.join(tempDir, "src"));
    await writeFile(path.join(tempDir, "README.md"), "alpha\nneedle here\n", "utf8");
    await writeFile(path.join(tempDir, "src", "notes.txt"), "first line\nNeedle too\n", "utf8");
    await writeFile(path.join(tempDir, "src", "index.ts"), "const ok = true;\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createGrepTool());

    const result = await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
      },
      {
        query: "needle",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "README.md:2| needle here\nsrc/notes.txt:2| Needle too" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        matches: 2,
        searchedFiles: 3,
        skippedBinaryFiles: 0,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("supports regex mode, file glob filtering, and result limits", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await mkdir(path.join(tempDir, "src"));
    await writeFile(path.join(tempDir, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    await writeFile(path.join(tempDir, "src", "b.ts"), "const c = 3;\n", "utf8");
    await writeFile(path.join(tempDir, "src", "notes.md"), "const should not match\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createGrepTool());

    const result = await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
      },
      {
        query: "const\\s+[ab]",
        literal: false,
        caseSensitive: true,
        glob: "*.ts",
        limit: 1,
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "src/a.ts:1| const a = 1;\n\n(1 matching lines shown. Narrow the query or increase limit for more.)",
        },
      ],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "const\\s+[ab]",
        literal: false,
        caseSensitive: true,
        glob: "*.ts",
        matches: 1,
        searchedFiles: 1,
        skippedBinaryFiles: 0,
        limit: 1,
        limitReached: true,
      },
    });
  });

  test("skips unreadable symlink targets and binary files", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-outside-"));

    await mkdir(path.join(tempDir, "inside"));
    await writeFile(path.join(tempDir, "inside", "visible.txt"), "needle\n", "utf8");
    await writeFile(path.join(tempDir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(outsideDir, "secret.txt"), "needle outside\n", "utf8");
    await symlink(outsideDir, path.join(tempDir, "outside-link"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createGrepTool());

    const result = await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        storage: handle.storage.db,
      },
      {
        query: "needle",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "inside/visible.txt:1| needle" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        matches: 1,
        searchedFiles: 1,
        skippedBinaryFiles: 1,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("denies searching the system directory", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    const registry = new ToolRegistry();
    registry.register(createGrepTool());

    await expect(
      registry.execute(
        "grep",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          storage: handle.storage.db,
        },
        {
          path: POKECLAW_SYSTEM_DIR,
          query: "secret",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: `The read request is blocked by system policy: ${POKECLAW_SYSTEM_DIR}`,
    } satisfies Partial<ToolFailure>);
  });
});
