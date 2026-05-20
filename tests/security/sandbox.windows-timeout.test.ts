import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { ToolExecutionContext } from "@/src/tools/core/types.js";

const { spawnMock, spawnCalls } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnCalls: [] as Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
    child: FakeChildProcess;
  }>,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

describe("Windows host bash timeout cleanup", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    spawnCalls.length = 0;
    spawnMock.mockImplementation(
      (command: string, args: string[] = [], options: Record<string, unknown> = {}) => {
        const child = createFakeChild(command === "taskkill" ? 456 : 123);
        spawnCalls.push({ command, args, options, child });

        if (command === "taskkill") {
          queueMicrotask(() => child.emit("close", 0, null));
        }

        return child;
      },
    );
  });

  afterEach(async () => {
    vi.resetModules();
    if (tempDir != null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("terminates the Windows host bash process tree before reporting timeout", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pokoclaw-windows-timeout-"));
    const { executeUnsandboxedBash } = await import("@/src/security/sandbox.js");

    await expect(
      executeUnsandboxedBash({
        context: {
          sessionId: "sess_1",
          conversationId: "conv_1",
          ownerAgentId: "agent_1",
          cwd: tempDir,
          securityConfig: DEFAULT_CONFIG.security,
          storage: {} as ToolExecutionContext["storage"],
          toolCallId: "tool_1",
        },
        command: "node child-process-that-outlives-bash.js",
        cwd: tempDir,
        timeoutMs: 5,
        platform: "win32",
      }),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      details: {
        code: "bash_timeout",
        timeoutMs: 5,
      },
    });

    expect(spawnCalls.map((call) => path.basename(call.command))).toEqual(["bash", "taskkill"]);
    expect(spawnCalls[1]).toMatchObject({
      command: "taskkill",
      args: ["/pid", "123", "/t", "/f"],
      options: {
        stdio: "ignore",
        windowsHide: true,
      },
    });
    expect(spawnCalls[0]?.child.kill).not.toHaveBeenCalled();
  });
});

function createFakeChild(pid: number): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}
