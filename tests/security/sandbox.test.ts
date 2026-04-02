import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { executeSandboxedCommandMock } = vi.hoisted(() => ({
  executeSandboxedCommandMock: vi.fn(),
}));

import { SandboxPermissionError } from "@anthropic-ai/sandbox-runtime";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { normalizeFilesystemTargetPath } from "@/src/security/permissions.js";
import { buildSystemPolicy } from "@/src/security/policy.js";
import { buildSandboxConfigForAgent, executeSandboxedBash } from "@/src/security/sandbox.js";
import { SecurityService } from "@/src/security/service.js";
import {
  POKECLAW_REPO_DIR,
  POKECLAW_SKILLS_DIR,
  POKECLAW_WORKSPACE_DIR,
} from "@/src/shared/paths.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

vi.mock("@anthropic-ai/sandbox-runtime", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/sandbox-runtime")>(
    "@anthropic-ai/sandbox-runtime",
  );

  return {
    ...actual,
    executeSandboxedCommand: executeSandboxedCommandMock,
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
  });

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

  test("builds main-agent sandbox config with broad home read but workspace-only write", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);

    const config = buildSandboxConfigForAgent({
      storage: handle.storage.db,
      ownerAgentId: "agent_main",
    });

    expect(config.filesystem.readMode).toBe("allow_only");
    expect(config.filesystem.allowRead).toContain(`${path.resolve(os.homedir())}/**`);
    expect(config.filesystem.allowWrite).toContain(
      `${path.resolve(path.join(os.homedir(), ".pokeclaw", "workspace"))}/**`,
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
      `${path.resolve(POKECLAW_WORKSPACE_DIR)}/**`,
      `${path.resolve(POKECLAW_SKILLS_DIR)}/**`,
      `${path.resolve(POKECLAW_REPO_DIR)}/**`,
    ]);
    expect(config.filesystem.allowWrite).toEqual([`${path.resolve(POKECLAW_WORKSPACE_DIR)}/**`]);
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-sandbox-test-"));
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

  test("turns ungranted filesystem sandbox blocks into approval requests", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedAgentFixture(handle);
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-sandbox-test-"));
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-sandbox-test-"));
    grantFilesystemScope(handle, "agent_sub", { kind: "fs.read", path: `${tempDir}/**` });
    executeSandboxedCommandMock.mockRejectedValue(
      new SandboxPermissionError({
        issues: [
          { kind: "fs.read", path: path.join(os.homedir(), ".pokeclaw", "system", "config.toml") },
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
        command: "cat ~/.pokeclaw/system/config.toml",
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-sandbox-test-"));
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-sandbox-test-"));
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
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokeclaw-sandbox-test-"));
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
