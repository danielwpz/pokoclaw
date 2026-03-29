import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { executeSandboxedBashMock, executeUnsandboxedBashMock } = vi.hoisted(() => ({
  executeSandboxedBashMock: vi.fn(),
  executeUnsandboxedBashMock: vi.fn(),
}));

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { SecurityService } from "@/src/security/service.js";
import { createBashTool } from "@/src/tools/bash.js";
import { type ToolFailure, toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
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
    executeUnsandboxedBash: executeUnsandboxedBashMock,
  };
});

describe("bash tool", () => {
  let handle: TestDatabaseHandle | null = null;

  beforeEach(() => {
    executeSandboxedBashMock.mockReset();
    executeUnsandboxedBashMock.mockReset();
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

    expect(result.details).toEqual({
      command: "pwd",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      exitCode: 0,
      signal: null,
      stdoutChars: 10,
      stderrChars: 0,
      outputTruncated: false,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: `<bash_result>
  <command>pwd</command>
  <cwd>/tmp/work</cwd>
  <exit_code>0</exit_code>
  <signal></signal>

  <stdout>
    /tmp/work
    
  </stdout>

  <stderr>
    
  </stderr>
</bash_result>`,
      },
    ]);
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

    expect(result.details).toEqual({
      command: "cat missing.txt",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      exitCode: 1,
      signal: null,
      stdoutChars: 0,
      stderrChars: 44,
      outputTruncated: false,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: `<bash_result>
  <command>cat missing.txt</command>
  <cwd>/tmp/work</cwd>
  <exit_code>1</exit_code>
  <signal></signal>

  <stdout>
    
  </stdout>

  <stderr>
    cat: missing.txt: No such file or directory
    
  </stderr>
</bash_result>`,
      },
    ]);
  });

  test("passes through permission-blocked failures from the sandbox adapter", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockRejectedValue(
      toolRecoverableError("Write /tmp/work/notes.txt access is missing.", {
        code: "permission_denied",
        requestable: true,
        summary: "Write /tmp/work/notes.txt access is missing.",
        entries: [
          {
            resource: "filesystem",
            path: "/tmp/work/notes.txt",
            scope: "exact",
            access: "write",
          },
        ],
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
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "permission_denied",
        requestable: true,
        entries: [
          {
            resource: "filesystem",
            path: "/tmp/work/notes.txt",
            scope: "exact",
            access: "write",
          },
        ],
      },
    } satisfies Partial<ToolFailure>);
  });

  test("requires justification before requesting bash full access", async () => {
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
          command: "npm run dev",
          sandboxMode: "full_access",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_requires_justification",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("rejects full-access-only arguments in sandboxed mode", async () => {
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
          command: "npm run dev",
          justification: "Need to run the dev server.",
          prefix: ["npm", "run"],
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_args_require_full_access_mode",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("uses an existing bash full-access prefix grant for a simple command", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["npm", "run"] }],
    });
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "FOO=1 npm run dev",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "ready\n",
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
        command: "FOO=1 npm run dev",
        sandboxMode: "full_access",
        justification: "Need to start the requested local dev server.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command: "FOO=1 npm run dev",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("rejects reusable full-access prefixes for complex shell commands", async () => {
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
          command: "npm run dev | tee out.log",
          sandboxMode: "full_access",
          justification: "Need to run the requested dev server and inspect output.",
          prefix: ["npm", "run"],
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_prefix_requires_simple_command",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("requests one-shot full access for complex commands without a prefix", async () => {
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
          command: "npm run dev | tee out.log",
          sandboxMode: "full_access",
          justification: "Need to run the requested dev server with full access.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      grantOnApprove: false,
      approvalTitle: "Approval required: run bash command with full access",
      request: {
        scopes: [{ kind: "bash.full_access", prefix: ["bash", "-lc"] }],
      },
    });
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

    expect(result.content).toEqual([
      {
        type: "text",
        text: `<bash_result>
  <command>echo ok &amp;&amp; echo still-ok</command>
  <cwd>/tmp/work</cwd>
  <exit_code>0</exit_code>
  <signal></signal>

  <stdout>
    ok
    still-ok
    
  </stdout>

  <stderr>
    
  </stderr>
</bash_result>`,
      },
    ]);

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
    "gh auth status 2>&1 || true",
    "echo $GITHUB_TOKEN && gh auth status 2>&1 || true",
    "npm test >out.log 2>&1",
    "echo ok >/dev/null 2>&1 && echo done",
    "printf 'warn\\n' 1>&2",
    "cat missing.txt >&2 || true",
    "run_job &>job.log || true",
    "run_job &>>job.log || true",
    "cat <&0",
    "exec 3>&1 1>&2 2>&3",
    "git status |& tee status.log",
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

    expect(result.content).toEqual([
      {
        type: "text",
        text: `<bash_result>
  <command>${escapeXml(command)}</command>
  <cwd>/tmp/work</cwd>
  <exit_code>0</exit_code>
  <signal></signal>

  <stdout>
    ok
    
  </stdout>

  <stderr>
    
  </stderr>
</bash_result>`,
      },
    ]);
    expect(executeSandboxedBashMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
      }),
    );
  });

  test.each([
    "sleep 60 >/tmp/sleep.log 2>&1 &",
    "long_task &>task.log &",
    "echo ok && worker >/tmp/worker.log 2>&1 &",
    "git status |& tee status.log &",
  ])("still rejects real background execution when redirection is also present: %s", async (command) => {
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
        reason: "unmanaged '&' background operator",
      },
    } satisfies Partial<ToolFailure>);

    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
  });
});

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
