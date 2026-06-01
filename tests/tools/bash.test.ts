import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { executeSandboxedBashMock, executeUnsandboxedBashMock } = vi.hoisted(() => ({
  executeSandboxedBashMock: vi.fn(),
  executeUnsandboxedBashMock: vi.fn(),
}));

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { detectRuntimeShellInfo } from "@/src/runtime/shell-info.js";
import type { ExecuteUnsandboxedBashInput } from "@/src/security/sandbox.js";
import { SecurityService } from "@/src/security/service.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { createBashTool } from "@/src/tools/bash.js";
import { type ToolFailure, toolRecoverableError } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

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
    mockProcessPlatform("linux");
    executeSandboxedBashMock.mockReset();
    executeUnsandboxedBashMock.mockReset();
  });

  afterEach(async () => {
    restoreProcessPlatform();
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  function seedSessionFixture(input: TestDatabaseHandle): void {
    input.storage.sqlite.exec(`
      INSERT INTO sessions (
        id,
        conversation_id,
        branch_id,
        owner_agent_id,
        purpose,
        created_at,
        updated_at
      )
      VALUES (
        'sess_1',
        'conv_1',
        'branch_1',
        'agent_1',
        'chat',
        '2026-03-22T00:00:00.000Z',
        '2026-03-22T00:00:00.000Z'
      );
    `);
  }

  function mockProcessPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
      enumerable: originalProcessPlatformDescriptor?.enumerable ?? true,
    });
  }

  function restoreProcessPlatform(): void {
    if (originalProcessPlatformDescriptor == null) {
      return;
    }

    Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
  }

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

  test("uses host full-access bash by default on native Windows when autopilot is enabled", async () => {
    mockProcessPlatform("win32");
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    const shellInfo = detectRuntimeShellInfo({
      platform: "win32",
      env: {},
      isExecutableAvailable: (candidate) => candidate === "pwsh.exe",
    });
    executeUnsandboxedBashMock.mockResolvedValue({
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
        shellInfo,
        approvalState: {
          runtimeModeAutoApproval: {
            source: "autopilot",
          },
        },
      },
      {
        command: "pwd",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sessionId: "sess_1",
      }),
      command: "pwd",
      timeoutMs: 10_000,
      shellInfo,
    });
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command: "pwd",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("rejects default native Windows bash unless autopilot is enabled", async () => {
    mockProcessPlatform("win32");
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);
    const failure = registry.execute(
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

    await expect(failure).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "windows_bash_requires_autopilot_full_access",
        requestedSandboxMode: "sandboxed",
      },
    } satisfies Partial<ToolFailure>);

    const message = await failure.catch((error) => (error instanceof Error ? error.message : ""));
    expect(message).toMatch(/Native Windows cannot run sandboxed bash commands yet\./);
    expect(message).toMatch(/\[runtime\] autopilot = true/);
    expect(message).toMatch(/full access/);
    expect(message).toMatch(/not Linux sandbox isolation/);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("does not treat YOLO as native Windows bash host-execution opt-in", async () => {
    mockProcessPlatform("win32");
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
          approvalState: {
            runtimeModeAutoApproval: {
              source: "yolo",
            },
          },
        },
        {
          command: "pwd",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "windows_bash_requires_autopilot_full_access",
      },
    } satisfies Partial<ToolFailure>);

    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
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

  test('adds a full-access hint for sandboxed shell "command not found" failures', async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command: "git --version",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "",
      stderr: "/bin/bash: git: command not found\n",
      exitCode: 127,
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
        command: "git --version",
      },
    );

    expect(result.details).toEqual({
      command: "git --version",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      exitCode: 127,
      signal: null,
      stdoutChars: 0,
      stderrChars: 34,
      outputTruncated: false,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: `<bash_result>
  <command>git --version</command>
  <cwd>/tmp/work</cwd>
  <exit_code>127</exit_code>
  <signal></signal>

  <stdout>
    
  </stdout>

  <stderr>
    /bin/bash: git: command not found
    
  </stderr>
</bash_result>

Hint: this sandboxed bash failure looks like a shell "not found" error.

In this environment that can be a sandbox symptom rather than proof that the command is truly unavailable.
If this command is normally expected to exist, consider retrying once with \`sandboxMode: "full_access"\` before concluding it is missing.

Use this exact bash argument object on the next retry if full access is warranted:
\`\`\`json
{
  "command": "git --version",
  "timeoutSec": 10,
  "sandboxMode": "full_access",
  "justification": "<one short sentence explaining why this exact command needs full access for the current user request>"
}
\`\`\``,
      },
    ]);
  });

  test('does not add a full-access hint for generic "not found" stderr that is not a shell command-missing error', async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command: "gh repo view missing/repo",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "",
      stderr:
        "GraphQL: Could not resolve to a Repository with the name 'missing/repo'. Repository not found.\n",
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
        command: "gh repo view missing/repo",
      },
    );

    expect(result.details).toEqual({
      command: "gh repo view missing/repo",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      exitCode: 1,
      signal: null,
      stdoutChars: 0,
      stderrChars: 95,
      outputTruncated: false,
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: `<bash_result>
  <command>gh repo view missing/repo</command>
  <cwd>/tmp/work</cwd>
  <exit_code>1</exit_code>
  <signal></signal>

  <stdout>
    
  </stdout>

  <stderr>
    GraphQL: Could not resolve to a Repository with the name 'missing/repo'. Repository not found.
    
  </stderr>
</bash_result>`,
      },
    ]);
  });

  test("passes timeoutSec through as timeoutMs to sandbox execution", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeSandboxedBashMock.mockResolvedValue({
      command: "pwd",
      cwd: "/tmp/work",
      timeoutMs: 45_000,
      stdout: "/tmp/work\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const registry = new ToolRegistry([createBashTool()]);
    await registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        agentKind: "sub",
        sessionPurpose: "chat",
        cwd: "/tmp/work",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {
        command: "pwd",
        timeoutSec: 45,
      },
    );

    expect(executeSandboxedBashMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pwd",
        timeoutMs: 45_000,
      }),
    );
  });

  test("returns actionable validation guidance for deprecated timeoutMs args", async () => {
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
          command: "pwd",
          timeoutMs: "5000",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "invalid_tool_args",
        toolName: "bash",
        allowedFields: ["command", "cwd", "timeoutSec", "sandboxMode", "justification", "prefix"],
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "/timeoutMs", message: "Unexpected property" }),
        ]),
      },
    });

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
          command: "pwd",
          timeoutMs: "5000",
        },
      ),
    ).rejects.toThrow(/\/timeoutMs: Unexpected property\./i);

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
          command: "pwd",
          timeoutMs: "5000",
        },
      ),
    ).rejects.toThrow(
      /Allowed fields: command, cwd, timeoutSec, sandboxMode, justification, prefix\./i,
    );
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

    const failure = registry.execute(
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
    );

    await expect(failure).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_requires_justification",
      },
    } satisfies Partial<ToolFailure>);

    const message = await failure.catch((error) => (error instanceof Error ? error.message : ""));
    expect(message).toMatch(/bash full_access requires `justification`\./);
    expect(message).toMatch(/Use this exact bash argument object on the next retry:/);
    expect(message).toMatch(/"command": "npm run dev"/);
    expect(message).toMatch(/"sandboxMode": "full_access"/);
    expect(message).toMatch(
      /"justification": "<one short sentence explaining why this exact command needs full access for the current user request>"/,
    );
  });

  test("rejects bash timeouts over 60 seconds for main chat agents", async () => {
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
          agentKind: "main",
          sessionPurpose: "chat",
          cwd: "/tmp/work",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {
          command: "sleep 65",
          timeoutSec: 65,
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_timeout_exceeds_main_agent_limit",
        requestedTimeoutSec: 65,
        maxTimeoutSec: 60,
      },
    } satisfies Partial<ToolFailure>);

    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
  });

  test("rejects full-access-only arguments in sandboxed mode", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);

    const failure = registry.execute(
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
    );

    await expect(failure).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_args_require_full_access_mode",
      },
    } satisfies Partial<ToolFailure>);

    const message = await failure.catch((error) => (error instanceof Error ? error.message : ""));
    expect(message).toMatch(
      /`justification` and `prefix` are only valid when `sandboxMode` is `"full_access"`\./,
    );
    expect(message).toMatch(/If you want a sandboxed call, use:/);
    expect(message).toMatch(/If you want a full-access call, use:/);
    expect(message).toMatch(/"command": "npm run dev"/);
    expect(message).toMatch(/"justification": "Need to run the dev server\."/);
    expect(message).toMatch(/"prefix": \[\n\s+"npm",\n\s+"run"\n\s+\]/);
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

  test("asks the agent to add a reusable prefix before first simple full-access approval", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);

    const failure = registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        ownerAgentId: "agent_1",
        cwd: "/tmp/work",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
        toolCallId: "tool_1",
        runId: "run_1",
      },
      {
        command: "pnpm test",
        sandboxMode: "full_access",
        justification: "Run the project test suite outside the sandbox.",
      },
    );

    await expect(failure).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_missing_prefix",
        command: "pnpm test",
        runId: "run_1",
      },
    } satisfies Partial<ToolFailure>);

    const message = await failure.catch((error) => (error instanceof Error ? error.message : ""));
    expect(message).toMatch(/This simple bash `full_access` call has no `prefix`/);
    expect(message).toMatch(/normalized argv starts with that prefix/);
    expect(message).toMatch(/balancing autonomy and risk/);
    expect(message).toMatch(/whole normalized command argv for exact repeats/);
    expect(message).toMatch(/genuinely one-off/);
    expect(message).toMatch(/Retry with the same command and justification/);
    expect(message).toMatch(/\["npm","test"\]/);
    expect(message).toMatch(/\["npm"\]/);
    expect(message).toMatch(/\["git"\]/);
    expect(message).toMatch(/"command": "pnpm test"/);
    expect(message).toMatch(/"sandboxMode": "full_access"/);
    expect(message).not.toMatch(/"prefix"/);
    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("falls back to one-shot approval when the same run already prompted for a missing prefix", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    seedSessionFixture(handle);
    new MessagesRepo(handle.storage.db).append({
      id: "msg_missing_prefix",
      sessionId: "sess_1",
      seq: 1,
      role: "tool",
      messageType: "tool_result",
      visibility: "hidden_system",
      payloadJson: JSON.stringify({
        toolCallId: "tool_1",
        toolName: "bash",
        content: [{ type: "text", text: "simple bash full_access command should include prefix" }],
        isError: true,
        details: {
          code: "bash_full_access_missing_prefix",
          command: "pnpm test",
          runId: "run_1",
        },
      }),
      createdAt: new Date("2026-03-22T00:00:01.000Z"),
    });

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
          toolCallId: "tool_2",
          runId: "run_1",
        },
        {
          command: "pnpm test",
          sandboxMode: "full_access",
          justification: "Run the project test suite outside the sandbox.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      grantOnApprove: false,
      approvalTitle: "Approval required: run bash command with full access",
      request: {
        scopes: [{ kind: "bash.full_access", prefix: ["pnpm", "test"] }],
      },
    });

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("allows retry with prefix after missing-prefix guidance", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "pnpm test",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

    const registry = new ToolRegistry([createBashTool()]);
    const context = {
      sessionId: "sess_1",
      conversationId: "conv_1",
      ownerAgentId: "agent_1",
      cwd: "/tmp/work",
      securityConfig: DEFAULT_CONFIG.security,
      storage: handle.storage.db,
      toolCallId: "tool_1",
      runId: "run_1",
    };

    await expect(
      registry.execute("bash", context, {
        command: "pnpm test",
        sandboxMode: "full_access",
        justification: "Run the project test suite outside the sandbox.",
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_missing_prefix",
      },
    } satisfies Partial<ToolFailure>);

    await expect(
      registry.execute(
        "bash",
        {
          ...context,
          toolCallId: "tool_2",
        },
        {
          command: "pnpm test",
          sandboxMode: "full_access",
          justification: "Run the project test suite outside the sandbox.",
          prefix: ["pnpm", "test"],
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      grantOnApprove: true,
      approvalTitle: "Approval required: run bash with full access for prefix pnpm test",
      request: {
        scopes: [{ kind: "bash.full_access", prefix: ["pnpm", "test"] }],
      },
    });

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();

    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["pnpm", "test"] }],
    });

    const result = await registry.execute(
      "bash",
      {
        ...context,
        toolCallId: "tool_3",
      },
      {
        command: "pnpm test",
        sandboxMode: "full_access",
        justification: "Run the project test suite outside the sandbox.",
        prefix: ["pnpm", "test"],
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      command: "pnpm test",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("does not reuse a one-shot bash full-access approval for a later tool call", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "agent-browser wait 5000 2>&1",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    });

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
          toolCallId: "tool_2",
          approvalState: {
            bashFullAccess: {
              approved: true,
              mode: "one_shot",
              approvalId: 43,
            },
          },
        },
        {
          command: "agent-browser wait 5000 2>&1",
          sandboxMode: "full_access",
          justification: "Wait for the browser page to finish rendering.",
        },
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
      grantOnApprove: false,
      request: {
        scopes: [{ kind: "bash.full_access", prefix: ["agent-browser", "wait", "5000"] }],
      },
    });

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("uses a one-shot bash full-access approval for the matching tool call retry", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "agent-browser wait 5000 2>&1",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "done\n",
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
        toolCallId: "tool_1",
        approvalState: {
          bashFullAccess: {
            approved: true,
            mode: "one_shot",
            approvalId: 43,
            toolCallId: "tool_1",
          },
        },
      },
      {
        command: "agent-browser wait 5000 2>&1",
        sandboxMode: "full_access",
        justification: "Wait for the browser page to finish rendering.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command: "agent-browser wait 5000 2>&1",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("uses existing bash full-access grants for every parsed subcommand in a compound command", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["agent-browser"] }],
    });
    executeUnsandboxedBashMock.mockResolvedValue({
      command:
        "agent-browser open https://example.com && agent-browser wait 2500 && agent-browser snapshot -s main > /tmp/browser.txt",
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
      {
        command:
          "agent-browser open https://example.com && agent-browser wait 2500 && agent-browser snapshot -s main > /tmp/browser.txt",
        sandboxMode: "full_access",
        justification: "Need to browse the requested page and save the captured output.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command:
        "agent-browser open https://example.com && agent-browser wait 2500 && agent-browser snapshot -s main > /tmp/browser.txt",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("still requests approval when a compound command is only partially covered by existing grants", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["agent-browser", "open"] }],
    });

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
          command:
            "agent-browser open https://example.com && agent-browser wait 2500 && agent-browser snapshot -s main > /tmp/browser.txt",
          sandboxMode: "full_access",
          justification: "Need to browse the requested page and save the captured output.",
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

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("allows a pure git compound workflow under a broad git prefix", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["git"] }],
    });
    executeUnsandboxedBashMock.mockResolvedValue({
      command:
        "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && git branch -vv",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "",
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
        command:
          "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && git branch -vv",
        sandboxMode: "full_access",
        justification: "Need to sync the branch and inspect the local repository state.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command:
        "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && git branch -vv",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("still requests approval for a git compound workflow when only narrower git prefixes are granted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [
        { kind: "bash.full_access", prefix: ["git", "fetch"] },
        { kind: "bash.full_access", prefix: ["git", "pull"] },
      ],
    });

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
          command:
            "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && git branch -vv",
          sandboxMode: "full_access",
          justification: "Need to sync the branch and inspect the local repository state.",
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

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("allows a literal echo separator inside an otherwise approved compound workflow", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["git"] }],
    });
    executeUnsandboxedBashMock.mockResolvedValue({
      command:
        "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && echo '---' && git branch -vv",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "",
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
        command:
          "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && echo '---' && git branch -vv",
        sandboxMode: "full_access",
        justification:
          "Need to sync the branch, inspect status, and print a separator before branch output.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command:
        "git fetch --prune origin && git checkout main && git pull --ff-only origin main && git status --short && echo '---' && git branch -vv",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("allows stdin-only output helpers after an approved full-access command", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["git", "pull"] }],
    });
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "git pull | tail -n 5 | wc -l",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "5\n",
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
        command: "git pull | tail -n 5 | wc -l",
        sandboxMode: "full_access",
        justification: "Need to update the branch and inspect the summarized output.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command: "git pull | tail -n 5 | wc -l",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("allows jq stdin filtering after an approved full-access command", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["near", "view"] }],
    });
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "near view contract method '{}' | jq -r .result",
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
      {
        command: "near view contract method '{}' | jq -r .result",
        sandboxMode: "full_access",
        justification: "Need to query the contract and extract the result field.",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      command: "near view contract method '{}' | jq -r .result",
      cwd: "/tmp/work",
      exitCode: 0,
    });
  });

  test("allows mixed approved commands and output helpers in realistic chained workflows", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [
        { kind: "bash.full_access", prefix: ["git"] },
        { kind: "bash.full_access", prefix: ["near", "view"] },
      ],
    });
    executeUnsandboxedBashMock.mockImplementation(async (input: ExecuteUnsandboxedBashInput) => ({
      command: input.command,
      cwd: input.cwd ?? input.context.cwd ?? "/tmp/work",
      timeoutMs: input.timeoutMs,
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    }));

    const registry = new ToolRegistry([createBashTool()]);
    const context = {
      sessionId: "sess_1",
      conversationId: "conv_1",
      ownerAgentId: "agent_1",
      cwd: "/tmp/work",
      securityConfig: DEFAULT_CONFIG.security,
      storage: handle.storage.db,
    };

    for (const command of [
      "git log --oneline -50 | head --quiet -n 5 && echo '--- status ---' && git status --short",
      "git diff --stat | tail -q -n 20 && echo '--- branches ---' && git branch -vv | head -n 10",
      "near view contract method '{}' | jq -r .result | head -n 20 && echo '--- repo ---' && git status --short",
      "near view contract method '{}' | jq '.result[] | .name' | head -n 20",
      "git status --short && echo '--- recent ---' && git log --oneline -20 | tail -n 5 | wc -l",
    ]) {
      const result = await registry.execute("bash", context, {
        command,
        sandboxMode: "full_access",
        justification: "Need to run the approved workflow and format the output.",
      });
      expect(result.details).toMatchObject({
        command,
        cwd: "/tmp/work",
        exitCode: 0,
      });
    }

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(5);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
  });

  test("still requests approval when helper-shaped commands introduce file or execution capability", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["git", "pull"] }],
    });

    const registry = new ToolRegistry([createBashTool()]);
    const context = {
      sessionId: "sess_1",
      conversationId: "conv_1",
      ownerAgentId: "agent_1",
      cwd: "/tmp/work",
      securityConfig: DEFAULT_CONFIG.security,
      storage: handle.storage.db,
    };

    for (const command of [
      "git pull | tail ~/.ssh/id_rsa",
      "git pull | tail -f",
      "git pull | head file.txt",
      "git pull | jq --rawfile k ~/.ssh/id_rsa .",
      "git pull | jq . file.json",
      "git pull | jq 'env.TEST_JQ_SECRET'",
      "git pull | jq 'import \"secrets\" as $s; .'",
      "git pull | jq 'include \"secrets\"; .'",
      "git pull | jq --arg home ~ .result",
      "git pull | jq --indent ~ .result",
      "git pull | tee out.txt",
      "git pull | xargs rm",
      "git pull && echo '---' > /tmp/marker",
      "git pull && echo $TOKEN",
      'git pull && echo "$(cat ~/.ssh/id_rsa)"',
      "git pull && echo *",
      "git pull && echo ~",
      "git pull && echo HOME=~",
      "git pull && echo PATH=a:~",
      "git pull && echo foo@(bar)",
      "git pull && echo {a,b}",
    ]) {
      await expect(
        registry.execute("bash", context, {
          command,
          sandboxMode: "full_access",
          justification: "Need to run the requested compound workflow.",
        }),
      ).rejects.toMatchObject({
        name: "ToolApprovalRequired",
        grantOnApprove: false,
        approvalTitle: "Approval required: run bash command with full access",
        request: {
          scopes: [{ kind: "bash.full_access", prefix: ["bash", "-lc"] }],
        },
      });
    }

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("still requests approval when an unapproved command remains after helper allowance", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    new SecurityService(handle.storage.db).grantScopes({
      ownerAgentId: "agent_1",
      grantedBy: "user",
      scopes: [{ kind: "bash.full_access", prefix: ["git", "fetch"] }],
    });

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
          command: "git fetch --prune origin && echo '---' && git status --short",
          sandboxMode: "full_access",
          justification: "Need to fetch and inspect the repository state.",
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

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("allows standalone literal echo helpers without an existing prefix grant", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeUnsandboxedBashMock.mockImplementation(async (input: ExecuteUnsandboxedBashInput) => ({
      command: input.command,
      cwd: input.cwd ?? input.context.cwd ?? "/tmp/work",
      timeoutMs: input.timeoutMs,
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    }));

    const registry = new ToolRegistry([createBashTool()]);
    const context = {
      sessionId: "sess_1",
      conversationId: "conv_1",
      ownerAgentId: "agent_1",
      cwd: "/tmp/work",
      securityConfig: DEFAULT_CONFIG.security,
      storage: handle.storage.db,
    };

    for (const command of ["echo '---'", "echo foo && echo bar", "echo foo | tail -n 1"]) {
      const result = await registry.execute("bash", context, {
        command,
        sandboxMode: "full_access",
        justification: "Need to print literal output markers.",
      });
      expect(result.details).toMatchObject({
        command,
        cwd: "/tmp/work",
        exitCode: 0,
      });
    }

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(3);
    expect(executeSandboxedBashMock).not.toHaveBeenCalled();
  });

  test("does not allow stdin-only helpers by name without a pipeline input", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);
    const context = {
      sessionId: "sess_1",
      conversationId: "conv_1",
      ownerAgentId: "agent_1",
      cwd: "/tmp/work",
      securityConfig: DEFAULT_CONFIG.security,
      storage: handle.storage.db,
    };

    for (const [command, prefix] of [
      ["jq .result", ["jq", ".result"]],
      ["tail -n 5", ["tail", "-n", "5"]],
      ["head -n 5", ["head", "-n", "5"]],
      ["wc -l", ["wc", "-l"]],
    ] as const) {
      await expect(
        registry.execute("bash", context, {
          command,
          sandboxMode: "full_access",
          justification: "Need to run the requested helper command.",
        }),
      ).rejects.toMatchObject({
        name: "ToolApprovalRequired",
        grantOnApprove: false,
        approvalTitle: "Approval required: run bash command with full access",
        request: {
          scopes: [{ kind: "bash.full_access", prefix }],
        },
      });
    }

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("rejects reusable full-access prefixes for complex shell commands", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);

    const failure = registry.execute(
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
    );

    await expect(failure).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_prefix_requires_simple_command",
      },
    } satisfies Partial<ToolFailure>);

    const message = await failure.catch((error) => (error instanceof Error ? error.message : ""));
    expect(message).toMatch(
      /`prefix` can only be used for a single simple command\. This command is compound\./,
    );
    expect(message).toMatch(/Use this exact bash argument object on the next retry:/);
    expect(message).toMatch(/"command": "npm run dev \| tee out\.log"/);
    expect(message).toMatch(/"sandboxMode": "full_access"/);
    expect(message).toMatch(
      /"justification": "Need to run the requested dev server and inspect output\."/,
    );
    expect(message).not.toMatch(/"prefix"/);
  });

  test("rejects non-matching reusable full-access prefixes with a one-shot repair object", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);

    const registry = new ToolRegistry([createBashTool()]);

    const failure = registry.execute(
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
        justification: "Need to start the requested dev server.",
        prefix: ["git", "status"],
      },
    );

    await expect(failure).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_full_access_prefix_not_command_prefix",
      },
    } satisfies Partial<ToolFailure>);

    const message = await failure.catch((error) => (error instanceof Error ? error.message : ""));
    expect(message).toMatch(/`prefix` must match the start of the command's normalized argv\./);
    expect(message).toMatch(/"command": "npm run dev"/);
    expect(message).toMatch(/"sandboxMode": "full_access"/);
    expect(message).toMatch(/"justification": "Need to start the requested dev server\."/);
    expect(message).not.toMatch(/"prefix"/);
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

  test("does not ask for missing-prefix guidance on compound full-access commands", async () => {
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
          toolCallId: "tool_1",
          runId: "run_1",
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

  test("allows the PowerShell call operator on native Windows autopilot execution", async () => {
    mockProcessPlatform("win32");
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    executeUnsandboxedBashMock.mockResolvedValue({
      command: "& 'C:\\Program Files\\Git\\bin\\git.exe' --version",
      cwd: "/tmp/work",
      timeoutMs: 10_000,
      stdout: "git version 2.50.0.windows.1\n",
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
        approvalState: {
          runtimeModeAutoApproval: {
            source: "autopilot",
          },
        },
      },
      {
        command: "& 'C:\\Program Files\\Git\\bin\\git.exe' --version",
      },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      command: "& 'C:\\Program Files\\Git\\bin\\git.exe' --version",
      exitCode: 0,
    });
  });

  test.each([
    {
      command: "Start-Sleep 60 &",
      reason: "unmanaged PowerShell '&' background job operator",
    },
    {
      command: "npm run dev &",
      reason: "unmanaged PowerShell '&' background job operator",
    },
    {
      command: "Start-Job -ScriptBlock { Start-Sleep 60 }",
      reason: "unmanaged PowerShell Start-Job backgrounding",
    },
  ])("rejects PowerShell background execution on native Windows: $command", async ({
    command,
    reason,
  }) => {
    mockProcessPlatform("win32");
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
          shellInfo: detectRuntimeShellInfo({
            platform: "win32",
            env: {},
            isExecutableAvailable: (candidate) => candidate === "pwsh.exe",
          }),
          approvalState: {
            runtimeModeAutoApproval: {
              source: "autopilot",
            },
          },
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

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test.each([
    "start /b npm run dev",
    'start "" /B long-task',
  ])("rejects cmd background execution on native Windows fallback: %s", async (command) => {
    mockProcessPlatform("win32");
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
          shellInfo: detectRuntimeShellInfo({
            platform: "win32",
            env: {
              ComSpec: "C:\\Windows\\System32\\cmd.exe",
            },
            isExecutableAvailable: (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
          }),
          approvalState: {
            runtimeModeAutoApproval: {
              source: "autopilot",
            },
          },
        },
        { command },
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_background_not_supported",
        reason: "unmanaged cmd START /B backgrounding",
      },
    } satisfies Partial<ToolFailure>);

    expect(executeUnsandboxedBashMock).not.toHaveBeenCalled();
  });

  test("does not treat a cmd START /D path containing /b as backgrounding", async () => {
    mockProcessPlatform("win32");
    handle = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(handle);
    const command = "start /D C:/b /WAIT program";
    executeUnsandboxedBashMock.mockResolvedValue({
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
        shellInfo: detectRuntimeShellInfo({
          platform: "win32",
          env: {
            ComSpec: "C:\\Windows\\System32\\cmd.exe",
          },
          isExecutableAvailable: (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
        }),
        approvalState: {
          runtimeModeAutoApproval: {
            source: "autopilot",
          },
        },
      },
      { command },
    );

    expect(executeUnsandboxedBashMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
      }),
    );
    expect(result.details).toMatchObject({
      command,
      exitCode: 0,
    });
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
