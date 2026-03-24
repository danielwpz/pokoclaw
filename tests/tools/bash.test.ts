import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { executeSandboxedBashMock } = vi.hoisted(() => ({
  executeSandboxedBashMock: vi.fn(),
}));

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createBashTool } from "@/src/tools/bash.js";
import {
  type ToolApprovalRequired,
  type ToolFailure,
  toolApprovalRequired,
} from "@/src/tools/errors.js";
import { ToolRegistry } from "@/src/tools/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

vi.mock("@/src/security/sandbox.js", async () => {
  const actual = await vi.importActual<typeof import("@/src/security/sandbox.js")>(
    "@/src/security/sandbox.js",
  );

  return {
    ...actual,
    executeSandboxedBash: executeSandboxedBashMock,
  };
});

describe("bash tool", () => {
  let handle: TestDatabaseHandle | null = null;

  beforeEach(() => {
    executeSandboxedBashMock.mockReset();
  });

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("returns stdout for a successful command", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command: "pwd",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "/tmp/work\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const registry = new ToolRegistry([createBashTool()]);
    const result = await registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: "/tmp/work",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        command: "pwd",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "/tmp/work\n" }],
      details: {
        command: "pwd",
        cwd: "/tmp/work",
        timeoutMs: 10_000,
        exitCode: 0,
        signal: null,
        stdoutChars: 10,
        stderrChars: 0,
        outputTruncated: false,
      },
    });
  });

  test("returns non-zero exits as normal tool results", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command: "cat missing.txt",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "",
      stderr: "cat: missing.txt: No such file or directory\n",
      exitCode: 1,
      signal: null,
    });

    const registry = new ToolRegistry([createBashTool()]);
    const result = await registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: "/tmp/work",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        command: "cat missing.txt",
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "cat: missing.txt: No such file or directory\n\n(Command exited with code 1.)",
        },
      ],
      details: {
        command: "cat missing.txt",
        cwd: "/tmp/work",
        timeoutMs: 10_000,
        exitCode: 1,
        signal: null,
        stdoutChars: 0,
        stderrChars: 44,
        outputTruncated: false,
      },
    });
  });

  test("passes through approval-required errors from the sandbox adapter", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockRejectedValue(
      toolApprovalRequired({
        request: {
          scopes: [{ kind: "fs.write", path: "/tmp/work/notes.txt" }],
        },
        reasonText: "This tool needs approval to continue: Write /tmp/work/notes.txt.",
      }),
    );

    const registry = new ToolRegistry([createBashTool()]);

    await expect(
      registry.execute(
        "bash",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: "/tmp/work",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          command: "echo hi > notes.txt",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      reasonText: "This tool needs approval to continue: Write /tmp/work/notes.txt.",
      request: {
        scopes: [{ kind: "fs.write", path: "/tmp/work/notes.txt" }],
      },
    } satisfies Partial<ToolApprovalRequired>);
  });

  test("rejects unmanaged background shell syntax before invoking sandbox execution", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);

    await expect(
      registry.execute(
        "bash",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: "/tmp/work",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          command: "sleep 60 &",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message:
        "Background shell jobs are not supported yet (unmanaged '&' background operator). Run the command in the foreground.",
      details: {
        code: "bash_background_not_supported",
      },
    } satisfies Partial<ToolFailure>);

    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
  });

  test("allows logical && while still rejecting background keywords", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command: "echo ok && echo still-ok",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "ok\nstill-ok\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const registry = new ToolRegistry([createBashTool()]);
    const result = await registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: "/tmp/work",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        command: "echo ok && echo still-ok",
      },
    );

    expect(result.content).toEqual([{ type: "text", text: "ok\nstill-ok\n" }]);

    await expect(
      registry.execute(
        "bash",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: "/tmp/work",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          command: "nohup sleep 60",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_background_not_supported",
        reason: "unmanaged nohup backgrounding",
      },
    } satisfies Partial<ToolFailure>);
  });

  test.each([
    {
      command: "setsid long_task",
      reason: "unmanaged setsid backgrounding",
    },
    {
      command: "echo hi; disown",
      reason: "unmanaged disown backgrounding",
    },
    {
      command: "echo one & echo two",
      reason: "unmanaged '&' background operator",
    },
  ])("rejects backgrounding form: $command", async ({ command, reason }) => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);

    await expect(
      registry.execute(
        "bash",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: "/tmp/work",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        { command },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_background_not_supported",
        reason,
      },
    } satisfies Partial<ToolFailure>);

    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
  });

  test.each([
    "printf 'a & b\\n'",
    'echo "nohup is just text"',
    "echo hi \\& echo there",
    "echo one && echo two || echo three",
  ])("does not false-positive on safe shell syntax: %s", async (command) => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command,
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const registry = new ToolRegistry([createBashTool()]);
    const result = await registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: "/tmp/work",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      { command },
    );

    expect(result.content).toEqual([{ type: "text", text: "ok\n" }]);
    expect(executeSandboxedBashMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
      }),
    );
  });
});
