import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import * as sandboxModule from "@/src/security/sandbox.js";
import { SecurityService } from "@/src/security/service.js";
import { POKECLAW_SYSTEM_DIR } from "@/src/shared/paths.js";
import { type ToolFailure, toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createGrepTool } from "@/src/tools/grep.js";
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
    vi.restoreAllMocks();
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

  function makeSandboxedRgResult(params: {
    stdout: string;
    stderr?: string;
    exitCode?: number;
    cwd: string;
  }) {
    return {
      command: "rg",
      cwd: params.cwd,
      timeoutMs: 9_500,
      stdout: params.stdout,
      stderr: params.stderr ?? "",
      exitCode: params.exitCode ?? 0,
      signal: null,
    };
  }

  function makeRgMatchEvent(filePath: string, lineNumber: number, text: string) {
    return JSON.stringify({
      type: "match",
      data: {
        path: { text: filePath },
        lines: { text: `${text}\n` },
        line_number: lineNumber,
      },
    });
  }

  function makeRgSummaryEvent(searches: number) {
    return JSON.stringify({
      type: "summary",
      data: {
        stats: {
          searches,
        },
      },
    });
  }

  function assertRipgrepInstalled(): void {
    const result = spawnSync("rg", ["--version"], { encoding: "utf8" });
    if (result.error != null || result.status !== 0) {
      throw new Error("rg is required for this test environment.");
    }
  }

  async function createRealGrepRegistry(rootDir: string) {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${rootDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createGrepTool());
    return registry;
  }

  async function executeRealGrep(
    rootDir: string,
    args: Record<string, unknown>,
    cwd: string = rootDir,
  ) {
    const registry = await createRealGrepRegistry(rootDir);
    const storage = handle?.storage.db;
    if (storage == null) {
      throw new Error("test database handle was not initialized");
    }
    return await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd,
        securityConfig: DEFAULT_CONFIG.security,
        storage,
      },
      args,
    );
  }

  test("uses real rg through the sandboxed grep backend for a basic directory search", async () => {
    assertRipgrepInstalled();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "alpha\nneedle here\n", "utf8");
    await writeFile(path.join(tempDir, "notes.txt"), "nothing to see\n", "utf8");
    const result = await executeRealGrep(tempDir, { query: "needle" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "README.md:2| needle here" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        backend: "rg",
        matches: 1,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("uses real rg through the sandboxed grep backend when there are no matches", async () => {
    assertRipgrepInstalled();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "alpha\nbeta\n", "utf8");
    await writeFile(path.join(tempDir, "notes.txt"), "nothing to see\n", "utf8");

    const result = await executeRealGrep(tempDir, { query: "needle" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "(no matches)" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        backend: "rg",
        matches: 0,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("uses real rg through the sandboxed grep backend for regex and case-sensitive matching", async () => {
    assertRipgrepInstalled();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "needle lower\nNeedle UPPER\n", "utf8");

    const result = await executeRealGrep(tempDir, {
      query: "Needle\\s+UPPER",
      literal: false,
      caseSensitive: true,
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "README.md:2| Needle UPPER" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "Needle\\s+UPPER",
        literal: false,
        caseSensitive: true,
        glob: null,
        backend: "rg",
        matches: 1,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("uses real rg through the sandboxed grep backend with glob filtering", async () => {
    assertRipgrepInstalled();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await mkdir(path.join(tempDir, "src"));
    await writeFile(path.join(tempDir, "src", "match.ts"), "const needle = true;\n", "utf8");
    await writeFile(path.join(tempDir, "src", "ignore.md"), "const needle = false;\n", "utf8");

    const result = await executeRealGrep(tempDir, {
      query: "const needle",
      glob: "*.ts",
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "src/match.ts:1| const needle = true;" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "const needle",
        literal: true,
        caseSensitive: false,
        glob: "*.ts",
        backend: "rg",
        matches: 1,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("uses real rg through the sandboxed grep backend with global result limits", async () => {
    assertRipgrepInstalled();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "needle one\nneedle two\n", "utf8");
    await writeFile(path.join(tempDir, "notes.txt"), "needle three\n", "utf8");

    const result = await executeRealGrep(tempDir, {
      query: "needle",
      limit: 1,
    });

    expect(result.details).toMatchObject({
      path: ".",
      absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
      query: "needle",
      literal: true,
      caseSensitive: false,
      glob: null,
      backend: "rg",
      matches: 1,
      limit: 1,
      limitReached: true,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^(README\.md|notes\.txt):1\| needle (one|three)\n\n\(1 matching lines shown\. Narrow the query or increase limit for more\.\)$/,
        ),
      },
    ]);
  });

  test("uses real rg through the sandboxed grep backend for an explicitly requested file", async () => {
    assertRipgrepInstalled();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    const targetFile = path.join(tempDir, "README.md");
    await writeFile(targetFile, "alpha\nneedle here\n", "utf8");
    await writeFile(path.join(tempDir, "notes.txt"), "needle elsewhere\n", "utf8");

    const result = await executeRealGrep(tempDir, {
      path: "README.md",
      query: "needle",
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "README.md:2| needle here" }],
      details: {
        path: "README.md",
        absolutePath: await resolveExpectedToolAbsolutePath(targetFile),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        backend: "rg",
        matches: 1,
        limit: 200,
        limitReached: false,
      },
    });
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
    const absoluteRoot = await resolveExpectedToolAbsolutePath(tempDir);
    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue(
      makeSandboxedRgResult({
        cwd: tempDir,
        stdout: [
          makeRgMatchEvent(path.join(absoluteRoot, "README.md"), 2, "needle here"),
          makeRgMatchEvent(path.join(absoluteRoot, "src", "notes.txt"), 2, "Needle too"),
          makeRgSummaryEvent(3),
        ].join("\n"),
      }),
    );

    const result = await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
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
        backend: "rg",
        matches: 2,
        searchedFiles: 3,
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
    const absoluteRoot = await resolveExpectedToolAbsolutePath(tempDir);
    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue(
      makeSandboxedRgResult({
        cwd: tempDir,
        stdout: [
          makeRgMatchEvent(path.join(absoluteRoot, "src", "a.ts"), 1, "const a = 1;"),
          makeRgMatchEvent(path.join(absoluteRoot, "src", "a.ts"), 2, "const b = 2;"),
          makeRgSummaryEvent(2),
        ].join("\n"),
      }),
    );

    const result = await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
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
        backend: "rg",
        matches: 1,
        searchedFiles: 2,
        limit: 1,
        limitReached: true,
      },
    });
  });

  test("builds the rg command with default ignore behavior instead of forcing hidden or no-ignore scanning", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "needle\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const sandboxSpy = vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue(
      makeSandboxedRgResult({
        cwd: tempDir,
        stdout: makeRgSummaryEvent(1),
        exitCode: 1,
      }),
    );

    const registry = new ToolRegistry();
    registry.register(createGrepTool());

    await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        query: "needle",
      },
    );

    expect(sandboxSpy).toHaveBeenCalledOnce();
    const sandboxInput = sandboxSpy.mock.calls[0]?.[0];
    expect(sandboxInput?.command).toContain("'rg'");
    expect(sandboxInput?.command).toContain("'--json'");
    expect(sandboxInput?.command).toContain("'--stats'");
    expect(sandboxInput?.command).toContain("'--no-messages'");
    expect(sandboxInput?.command).not.toContain("'--hidden'");
    expect(sandboxInput?.command).not.toContain("'--no-ignore'");
    expect(sandboxInput?.command).not.toContain("!**/.git/**");
    expect(sandboxInput?.command).not.toContain("!**/node_modules/**");
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
    const absoluteRoot = await resolveExpectedToolAbsolutePath(tempDir);
    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue(
      makeSandboxedRgResult({
        cwd: tempDir,
        stdout: [
          makeRgMatchEvent(path.join(absoluteRoot, "inside", "visible.txt"), 1, "needle"),
          makeRgSummaryEvent(2),
        ].join("\n"),
      }),
    );

    const result = await registry.execute(
      "grep",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
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
        backend: "rg",
        matches: 1,
        searchedFiles: 2,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("falls back to the JS walker when rg is unavailable and still skips directory symlink targets", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));
    outsideDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-outside-"));

    await mkdir(path.join(tempDir, "inside"));
    await writeFile(path.join(tempDir, "inside", "visible.txt"), "needle\n", "utf8");
    await writeFile(path.join(outsideDir, "secret.txt"), "needle outside\n", "utf8");
    await symlink(outsideDir, path.join(tempDir, "outside-link"));

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const sandboxSpy = vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue({
      command: "rg",
      cwd: tempDir,
      timeoutMs: 9_500,
      stdout: "",
      stderr: "rg: command not found",
      exitCode: 127,
      signal: null,
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
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        query: "needle",
      },
    );

    expect(sandboxSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      content: [{ type: "text", text: "inside/visible.txt:1| needle" }],
      details: {
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        backend: "js",
        matches: 1,
        searchedFiles: 1,
        skippedBinaryFiles: 0,
        limit: 200,
        limitReached: false,
      },
    });
  });

  test("does not fall back to the JS walker when rg exits with an unexpected error", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "needle\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue({
      command: "rg",
      cwd: tempDir,
      timeoutMs: 9_500,
      stdout: "",
      stderr: "regex parse error",
      exitCode: 2,
      signal: null,
    });

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
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          query: "needle",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "grep_rg_failed",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("does not fall back to the JS walker when rg returns malformed output", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "needle\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue({
      command: "rg",
      cwd: tempDir,
      timeoutMs: 9_500,
      stdout: "not valid json",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

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
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          query: "needle",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "grep_rg_parse_failed",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("does not fall back to the JS walker when sandbox rejects the rg search", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    await writeFile(path.join(tempDir, "README.md"), "needle\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    vi.spyOn(sandboxModule, "executeSandboxedBash").mockRejectedValue(
      toolRecoverableError("Read access is missing for /blocked", {
        code: "permission_denied",
        path: "/blocked",
      }),
    );

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
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          query: "needle",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "grep_rg_failed",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("continues broad scans but reports unreadable paths as warnings", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    const readableDir = path.join(tempDir, "inside");
    const unreadableDir = path.join(tempDir, "private");
    await mkdir(readableDir);
    await mkdir(unreadableDir);
    await writeFile(path.join(readableDir, "visible.txt"), "needle\n", "utf8");
    await writeFile(path.join(unreadableDir, "secret.txt"), "needle hidden\n", "utf8");

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createGrepTool());
    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue({
      command: "rg",
      cwd: tempDir,
      timeoutMs: 9_500,
      stdout: "",
      stderr: "rg: command not found",
      exitCode: 127,
      signal: null,
    });

    await chmod(unreadableDir, 0o000);
    try {
      const result = await registry.execute(
        "grep",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          query: "needle",
        },
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("inside/visible.txt:1| needle"),
        },
      ]);
      expect((result.content[0] as { type: string; text: string }).text).toContain(
        "Warning: skipped 1 unreadable path:",
      );
      expect((result.content[0] as { type: string; text: string }).text).toContain("private");
      expect(result.details).toMatchObject({
        path: ".",
        absolutePath: await resolveExpectedToolAbsolutePath(tempDir),
        query: "needle",
        literal: true,
        caseSensitive: false,
        glob: null,
        backend: "js",
        matches: 1,
        searchedFiles: 1,
        skippedBinaryFiles: 0,
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-grep-tool-"));

    const unreadableRoot = path.join(tempDir, "private");
    await mkdir(unreadableRoot);

    const security = new SecurityService(handle.storage.db);
    security.grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "main_agent",
      scopes: [{ kind: "fs.read", path: `${tempDir}/**` }],
    });

    const registry = new ToolRegistry();
    registry.register(createGrepTool());
    vi.spyOn(sandboxModule, "executeSandboxedBash").mockResolvedValue({
      command: "rg",
      cwd: tempDir,
      timeoutMs: 9_500,
      stdout: "",
      stderr: "rg: command not found",
      exitCode: 127,
      signal: null,
    });

    await chmod(unreadableRoot, 0o000);
    try {
      await expect(
        registry.execute(
          "grep",
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
            query: "needle",
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
          securityConfig: DEFAULT_CONFIG.security,
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
