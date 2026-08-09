import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { executeSandboxedCommandMock, startSandboxedCommandMock } = vi.hoisted(() => ({
  executeSandboxedCommandMock: vi.fn(),
  startSandboxedCommandMock: vi.fn(),
}));

import { SandboxManager, SandboxPermissionError } from "@danielwpz/sandbox-runtime";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { normalizeFilesystemTargetPath } from "@/src/security/permissions.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import {
  buildSandboxConfigForAgent,
  executeSandboxedBash,
  executeUnsandboxedBash,
  startSandboxedBash,
  startUnsandboxedBash,
} from "@/src/security/sandbox.js";
import { SecurityService } from "@/src/security/service.js";
import {
  POKOCLAW_REPO_DIR,
  POKOCLAW_SKILLS_DIR,
  POKOCLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

vi.mock("@danielwpz/sandbox-runtime", async () => {
  const actual = await vi.importActual<typeof import("@danielwpz/sandbox-runtime")>(
    "@danielwpz/sandbox-runtime",
  );

  return {
    ...actual,
    executeSandboxedCommand: executeSandboxedCommandMock,
    startSandboxedCommand: startSandboxedCommandMock,
  };
});

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

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_2', 'ci_1', 'chat_2', 'group', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_2', 'conv_2', 'group_main', 'main', '2026-03-22T00:00:00.000Z', '2026-03-22T00:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, created_at)
    VALUES ('agent_sub', 'conv_2', 'sub', '2026-03-22T00:00:00.000Z');
  `);
}

function grantFilesystemScope(
  handle: TestDatabaseHandle,
  ownerAgentId: string,
  scope: { kind: "fs.read" | "fs.write"; path: string },
): void {
  const security = new SecurityService(handle.storage.db);
  security.grantScopes({
    ownerAgentId,
    grantedBy: "main_agent",
    scopes: [scope],
  });
}

describe("sandbox config compilation", () => {
  let handle: TestDatabaseHandle | null = null;
  let tempDir: string | null = null;

  beforeEach(() => {
    executeSandboxedCommandMock.mockReset();
    startSandboxedCommandMock.mockReset();
  });

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
  });

  test("builds main-agent sandbox config with broad home read but workspace-only write", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);

    const config = buildSandboxConfigForAgent({
      storage: handle.storage.db,
      ownerAgentId: "agent_main",
    });

    expect(config.filesystem.readMode).toBe("allow_only");
    expect(config.filesystem.allowRead).toContain(`${path.resolve(os.homedir())}/**`);
    expect(config.filesystem.allowRead).toContain(path.resolve(os.homedir()));
    expect(config.filesystem.allowWrite).toContain(
      `${path.resolve(path.join(os.homedir(), ".pokoclaw", "workspace"))}/**`,
    );
    expect(config.filesystem.allowWrite).toContain(
      path.resolve(path.join(os.homedir(), ".pokoclaw", "workspace")),
    );
    expect(config.filesystem.allowWrite).not.toContain(`${path.resolve(os.homedir())}/**`);
  });

  test("builds subagent sandbox config with workspace write plus trusted skill/source read paths", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);

    const config = buildSandboxConfigForAgent({
      storage: handle.storage.db,
      ownerAgentId: "agent_sub",
    });

    expect(config.filesystem.readMode).toBe("allow_only");
    expect(config.filesystem.allowRead).toEqual([
      path.resolve(POKOCLAW_WORKSPACE_DIR),
      `${path.resolve(POKOCLAW_WORKSPACE_DIR)}/**`,
      path.resolve(POKOCLAW_SKILLS_DIR),
      `${path.resolve(POKOCLAW_SKILLS_DIR)}/**`,
      path.resolve(POKOCLAW_REPO_DIR),
      `${path.resolve(POKOCLAW_REPO_DIR)}/**`,
    ]);
    expect(config.filesystem.allowWrite).toEqual([
      path.resolve(POKOCLAW_WORKSPACE_DIR),
      `${path.resolve(POKOCLAW_WORKSPACE_DIR)}/**`,
    ]);
  });

  test("expands a granted read subtree so the directory node itself remains readable to sandboxed processes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));

    grantFilesystemScope(handle, "agent_sub", {
      kind: "fs.read",
      path: `${tempDir}/**`,
    });

    const config = buildSandboxConfigForAgent({
      storage: handle.storage.db,
      ownerAgentId: "agent_sub",
    });

    const normalizedTempDir = normalizeFilesystemTargetPath(tempDir);
    expect(config.filesystem.allowRead).toContain(normalizedTempDir);
    expect(config.filesystem.allowRead).toContain(`${normalizedTempDir}/**`);
  });

  test("expands a granted write subtree so the directory node itself remains writable to sandboxed processes", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));

    grantFilesystemScope(handle, "agent_sub", {
      kind: "fs.write",
      path: `${tempDir}/**`,
    });

    const config = buildSandboxConfigForAgent({
      storage: handle.storage.db,
      ownerAgentId: "agent_sub",
    });

    const normalizedTempDir = normalizeFilesystemTargetPath(tempDir);
    expect(config.filesystem.allowWrite).toContain(normalizedTempDir);
    expect(config.filesystem.allowWrite).toContain(`${normalizedTempDir}/**`);
  });

  test("compiles network hard-deny hosts into deny_only sandbox mode", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);

    const config = buildSandboxConfigForAgent({
      storage: handle.storage.db,
      ownerAgentId: "agent_sub",
      systemPolicy: buildSystemPolicy({
        security: {
          filesystem: {
            overrideHardDenyRead: false,
            overrideHardDenyWrite: false,
            hardDenyRead: [],
            hardDenyWrite: [],
          },
          network: {
            overrideHardDenyHosts: false,
            hardDenyHosts: ["internal.example.com"],
          },
        },
      }),
    });

    expect(config.network.mode).toBe("deny_only");
    expect(config.network.allowedDomains).toEqual([]);
    expect(config.network.deniedDomains).toContain("169.254.169.254");
    expect(config.network.deniedDomains).toContain("internal.example.com");
  });

  test("executes bash through the sandbox with sanitized env and compiled config", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    await mkdir(path.join(tempDir, "workspace"), { recursive: true });
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    executeSandboxedCommandMock.mockResolvedValue({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const originalOpenAi = process.env.OPENAI_API_KEY;
    const originalBashEnv = process.env.BASH_ENV;
    const originalEnv = process.env.ENV;
    const originalShell = process.env.SHELL;
    const originalZdotdir = process.env.ZDOTDIR;
    const originalPromptCommand = process.env.PROMPT_COMMAND;
    const originalHistfile = process.env.HISTFILE;
    const originalBashFuncFoo = process.env["BASH_FUNC_foo%%"];
    const originalPath = process.env.PATH;
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.BASH_ENV = "/tmp/bash_env";
    process.env.ENV = "/tmp/sh_env";
    process.env.SHELL = "/bin/zsh";
    process.env.ZDOTDIR = "/tmp/zdotdir";
    process.env.PROMPT_COMMAND = "echo prompt";
    process.env.HISTFILE = "/tmp/bash_history";
    process.env["BASH_FUNC_foo%%"] = "() { echo nope; }";
    process.env.PATH = "/usr/local/bin:/usr/bin";

    try {
      const result = await executeSandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: "echo hello",
        cwd: tempDir,
        timeoutMs: 10_000,
      });

      expect(result).toEqual({
        command: "echo hello",
        cwd: normalizeFilesystemTargetPath(tempDir),
        timeoutMs: 10_000,
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
        signal: null,
      });
      expect(executeSandboxedCommandMock).toHaveBeenCalledTimes(1);
      const [command, options] = executeSandboxedCommandMock.mock.calls[0] ?? [];
      expect(command).toBe("echo hello");
      expect(options?.binShell).toBe("/bin/bash");
      expect(options?.cwd).toBe(normalizeFilesystemTargetPath(tempDir));
      expect(options?.customConfig?.filesystem?.readMode).toBe("allow_only");
      expect(options?.customConfig?.network?.mode).toBe("deny_only");
      expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options?.env?.BASH_ENV).toBeUndefined();
      expect(options?.env?.ENV).toBeUndefined();
      expect(options?.env?.ZDOTDIR).toBeUndefined();
      expect(options?.env?.PROMPT_COMMAND).toBeUndefined();
      expect(options?.env?.HISTFILE).toBeUndefined();
      expect(options?.env?.["BASH_FUNC_foo%%"]).toBeUndefined();
      expect(options?.env?.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(options?.env?.SHELL).toBe("/bin/bash");
    } finally {
      if (originalOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAi;
      }
      if (originalBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = originalBashEnv;
      }
      if (originalEnv === undefined) {
        delete process.env.ENV;
      } else {
        process.env.ENV = originalEnv;
      }
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
      if (originalZdotdir === undefined) {
        delete process.env.ZDOTDIR;
      } else {
        process.env.ZDOTDIR = originalZdotdir;
      }
      if (originalPromptCommand === undefined) {
        delete process.env.PROMPT_COMMAND;
      } else {
        process.env.PROMPT_COMMAND = originalPromptCommand;
      }
      if (originalHistfile === undefined) {
        delete process.env.HISTFILE;
      } else {
        process.env.HISTFILE = originalHistfile;
      }
      if (originalBashFuncFoo === undefined) {
        delete process.env["BASH_FUNC_foo%%"];
      } else {
        process.env["BASH_FUNC_foo%%"] = originalBashFuncFoo;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  test("starts a managed sandbox command with live streams and startup-only cancellation", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-managed-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const terminate = vi.fn(async () => {});
    startSandboxedCommandMock.mockResolvedValue({
      pid: 123,
      stdout,
      stderr,
      wait: vi.fn(async () => ({ stdout: "ready\n", stderr: "", exitCode: 0, signal: null })),
      terminate,
    });
    const startupController = new AbortController();

    const managed = await startSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command: "node server.js",
      cwd: tempDir,
      abortSignal: startupController.signal,
    });

    expect(managed).toMatchObject({ pid: 123, stdout, stderr });
    expect(await managed.wait()).toEqual({
      stdout: "ready\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });
    await managed.terminate({ graceMs: 250 });
    expect(terminate).toHaveBeenCalledWith({ graceMs: 250 });
    expect(startSandboxedCommandMock).toHaveBeenCalledWith(
      "node server.js",
      expect.objectContaining({
        binShell: "/bin/bash",
        cwd: normalizeFilesystemTargetPath(tempDir),
        abortSignal: startupController.signal,
        maxOutputChars: 128_000,
      }),
    );
  });

  test("translates a managed sandbox permission failure discovered by wait", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-managed-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    const blockedPath = normalizeFilesystemTargetPath(path.join(tempDir, "blocked.txt"));
    startSandboxedCommandMock.mockResolvedValue({
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: vi.fn(async () => {
        throw new SandboxPermissionError({
          issues: [{ kind: "fs.write", path: blockedPath }],
          stdout: "",
          stderr: "operation not permitted",
          exitCode: 1,
          signal: null,
        });
      }),
      terminate: vi.fn(async () => {}),
    });

    const managed = await startSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command: "touch blocked.txt",
      cwd: tempDir,
      abortSignal: new AbortController().signal,
    });

    await expect(managed.wait()).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: true,
        failedToolCallId: "tool_1",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("re-polls late macOS violations when managed wait resolves a permission failure", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-managed-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    const command = "touch blocked.txt";
    const blockedPath = normalizeFilesystemTargetPath(path.join(tempDir, "blocked.txt"));
    const violationStore = SandboxManager.getSandboxViolationStore();
    vi.spyOn(violationStore, "getTotalCount").mockReturnValue(41);
    const getViolationsForCommandSince = vi
      .spyOn(violationStore, "getViolationsForCommandSince")
      .mockReturnValue([
        {
          line: `Sandbox: bash deny file-write-data ${blockedPath}`,
          command,
          timestamp: new Date(),
        },
      ]);
    startSandboxedCommandMock.mockResolvedValue({
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: vi.fn(async () => ({
        stdout: "",
        stderr: "touch: blocked.txt: Operation not permitted",
        exitCode: 1,
        signal: null,
      })),
      terminate: vi.fn(async () => {}),
    });

    const managed = await startSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command,
      cwd: tempDir,
      abortSignal: new AbortController().signal,
      platform: "darwin",
    });

    await expect(managed.wait()).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: true,
        failedToolCallId: "tool_1",
      },
    } satisfies Partial<ToolFailure>);
    expect(getViolationsForCommandSince).toHaveBeenCalledWith(command, 41);
  });

  test("executes full-access bash through host spawn with sanitized env", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    const originalOpenAi = process.env.OPENAI_API_KEY;
    const originalBashEnv = process.env.BASH_ENV;
    const originalShell = process.env.SHELL;
    const originalPath = process.env.PATH;
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.BASH_ENV = "/tmp/bash_env";
    process.env.SHELL = "/bin/zsh";
    process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
    const hostEnvProbeCommand = [
      'printf "%s\\n"',
      '"$' + '{OPENAI_API_KEY-unset}"',
      '"$' + '{BASH_ENV-unset}"',
      '"$SHELL"',
      '"$PWD"',
    ].join(" ");

    try {
      const result = await executeUnsandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: hostEnvProbeCommand,
        cwd: tempDir,
        timeoutMs: 10_000,
      });

      expect(result).toMatchObject({
        command: hostEnvProbeCommand,
        cwd: normalizeFilesystemTargetPath(tempDir),
        timeoutMs: 10_000,
        stdout: `unset\nunset\n/bin/bash\n${normalizeFilesystemTargetPath(tempDir)}\n`,
        stderr: "",
        exitCode: 0,
        signal: null,
      });
      expect(executeSandboxedCommandMock).not.toHaveBeenCalled();
    } finally {
      if (originalOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAi;
      }
      if (originalBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = originalBashEnv;
      }
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  test("starts and terminates a managed full-access process", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-managed-host-test-"));
    const managed = await startUnsandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command: 'printf "ready\\n"; while true; do sleep 1; done',
      cwd: tempDir,
      abortSignal: new AbortController().signal,
      platform: "linux",
    });

    expect(managed.pid).toEqual(expect.any(Number));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Managed process did not emit output.")),
        1_000,
      );
      managed.stdout?.once("data", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await managed.terminate({ graceMs: 100 });
    const result = await managed.wait();
    expect(result.stdout).toContain("ready");
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  test("turns full-access host spawn timeout into a recoverable failure", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));

    await expect(
      executeUnsandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: "sleep 60",
        cwd: tempDir,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "The bash command timed out after 5ms.",
      details: {
        code: "bash_timeout",
        timeoutMs: 5,
      },
    } satisfies Partial<ToolFailure>);

    expect(executeSandboxedCommandMock).not.toHaveBeenCalled();
  });

  test("aborts full-access host spawn when the upstream signal is already aborted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    const upstreamAbort = new AbortController();
    upstreamAbort.abort();

    await expect(
      executeUnsandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          abortSignal: upstreamAbort.signal,
          toolCallId: "tool_1",
        },
        command: "printf should-not-run",
        cwd: tempDir,
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(executeSandboxedCommandMock).not.toHaveBeenCalled();
  });

  test("adds direct children of an exactly granted read directory to sandbox allowRead", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    const chatApiDir = path.join(tempDir, "chat-api");
    const stripeNodeDir = path.join(tempDir, "stripe-node");
    await mkdir(chatApiDir);
    await mkdir(stripeNodeDir);

    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: tempDir });
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${chatApiDir}/**` });

    executeSandboxedCommandMock.mockResolvedValue({
      stdout: "chat-api/\nstripe-node/\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    await executeSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: chatApiDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command: "ls",
      cwd: tempDir,
      timeoutMs: 10_000,
    });

    const [, options] = executeSandboxedCommandMock.mock.calls[0] ?? [];
    expect(options?.customConfig?.filesystem?.allowRead).toContain(
      normalizeFilesystemTargetPath(chatApiDir),
    );
    expect(options?.customConfig?.filesystem?.allowRead).toContain(
      normalizeFilesystemTargetPath(stripeNodeDir),
    );
  });

  test("does not expand exact read directory grants through escaping symlink children", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    const parentDir = path.join(tempDir, "near-ai");
    const allowedChildDir = path.join(parentDir, "chat-api");
    const outsideDir = path.join(tempDir, "outside");
    const escapingLink = path.join(parentDir, "stripe-node");
    await mkdir(allowedChildDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "package.json"), "{}", "utf8");
    await symlink(outsideDir, escapingLink);

    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: parentDir });

    executeSandboxedCommandMock.mockResolvedValue({
      stdout: "chat-api/\nstripe-node@\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    await executeSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: allowedChildDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
      },
      command: "ls",
      cwd: parentDir,
      timeoutMs: 10_000,
    });

    const [, options] = executeSandboxedCommandMock.mock.calls[0] ?? [];
    expect(options?.customConfig?.filesystem?.allowRead).toContain(
      normalizeFilesystemTargetPath(allowedChildDir),
    );
    expect(options?.customConfig?.filesystem?.allowRead).not.toContain(
      normalizeFilesystemTargetPath(outsideDir),
    );
  });

  test("turns ungranted filesystem sandbox blocks into approval requests", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    const expectedBlockedPath = normalizeFilesystemTargetPath(path.join(tempDir, "notes.txt"));
    executeSandboxedCommandMock.mockRejectedValue(
      new SandboxPermissionError({
        issues: [{ kind: "fs.write", path: expectedBlockedPath }],
        stdout: "",
        stderr: "",
        exitCode: 1,
        signal: null,
      }),
    );

    await expect(
      executeSandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: "echo hi > notes.txt",
        cwd: tempDir,
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: true,
        entries: [
          {
            resource: "filesystem",
            path: expectedBlockedPath,
            scope: "exact",
            access: "write",
          },
        ],
      },
    } satisfies Partial<ToolFailure>);
  });

  test("turns hard-denied filesystem sandbox blocks into recoverable tool failures", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    executeSandboxedCommandMock.mockRejectedValue(
      new SandboxPermissionError({
        issues: [
          { kind: "fs.read", path: path.join(os.homedir(), ".pokoclaw", "system", "config.toml") },
        ],
        stdout: "",
        stderr: "",
        exitCode: 1,
        signal: null,
      }),
    );

    await expect(
      executeSandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: "cat ~/.pokoclaw/system/config.toml",
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: expect.stringContaining("blocked by system policy"),
    } satisfies Partial<ToolFailure>);
  });

  test("turns blocked network access into recoverable tool failures", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    executeSandboxedCommandMock.mockRejectedValue(
      new SandboxPermissionError({
        issues: [{ kind: "network", host: "169.254.169.254", port: 80 }],
        stdout: "",
        stderr: "",
        exitCode: 1,
        signal: null,
      }),
    );

    await expect(
      executeSandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: "curl http://169.254.169.254/latest/meta-data",
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "Network access is blocked for 169.254.169.254:80",
    } satisfies Partial<ToolFailure>);
  });

  test("turns sandbox aborts caused by timeout into recoverable timeout failures", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });

    executeSandboxedCommandMock.mockImplementation(async (_command, options) => {
      await new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    });

    await expect(
      executeSandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_2",
          ownerAgentId: "agent_sub",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
          toolCallId: "tool_1",
        },
        command: "sleep 60",
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "The bash command timed out after 5ms.",
      details: {
        code: "bash_timeout",
        timeoutMs: 5,
      },
    } satisfies Partial<ToolFailure>);
  });

  test("passes through the combined abort signal to sandbox-runtime", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });

    const upstreamAbort = new AbortController();
    const commandState: { finish?: () => void } = {};
    executeSandboxedCommandMock.mockImplementation(
      (
        _command,
        options,
      ): Promise<{ stdout: string; stderr: string; exitCode: number; signal: null }> => {
        expect(options?.abortSignal?.aborted).toBe(false);
        return new Promise((resolve) => {
          commandState.finish = () =>
            resolve({
              stdout: "",
              stderr: "",
              exitCode: 0,
              signal: null,
            });
        });
      },
    );

    const runPromise = executeSandboxedBash({
      context: {
        sessionId: "sess_1",
        conversationId: "conv_2",
        ownerAgentId: "agent_sub",
        cwd: tempDir,
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        abortSignal: upstreamAbort.signal,
        toolCallId: "tool_1",
      },
      command: "sleep 60",
      timeoutMs: 10_000,
    });

    while (executeSandboxedCommandMock.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const [, options] = executeSandboxedCommandMock.mock.calls[0] ?? [];
    upstreamAbort.abort();
    expect(options?.abortSignal?.aborted).toBe(true);

    if (commandState.finish != null) {
      commandState.finish();
    }
    await runPromise;
  });
});
