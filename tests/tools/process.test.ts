import { describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { ShellProcessView } from "@/src/runtime/shell-process-manager.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createProcessTool } from "@/src/tools/process.js";

describe("process tool", () => {
  test("lists only through the current owner context", async () => {
    const manager = {
      list: vi.fn(() => [makeView().processRun]),
    };
    const result = await execute(manager, { action: "list", limit: 5 });

    expect(manager.list).toHaveBeenCalledWith("agent_1", 5);
    expect(result.content).toEqual([
      {
        type: "json",
        json: {
          processes: [
            expect.objectContaining({
              processRunId: "process_1",
              status: "running",
              command: "node server.js",
            }),
          ],
        },
      },
    ]);
  });

  test("polls bounded incremental output with a resumable cursor", async () => {
    const manager = {
      get: vi.fn(() => makeView()),
    };
    const result = await execute(manager, {
      action: "poll",
      processRunId: "process_1",
      afterCursor: 4,
      maxChars: 256,
    });

    expect(manager.get).toHaveBeenCalledWith({
      id: "process_1",
      ownerAgentId: "agent_1",
      afterCursor: 4,
    });
    expect(result.content[0]).toMatchObject({
      type: "json",
      json: {
        output: {
          chunks: [
            {
              cursorStart: 4,
              cursorEnd: 260,
              stream: "stdout",
              text: "x".repeat(256),
            },
          ],
          nextCursor: 260,
          availableThroughCursor: 304,
          hasMore: true,
        },
      },
    });
  });

  test("kills a managed process through the owner-scoped manager", async () => {
    const manager = {
      kill: vi.fn(async () => ({
        ...makeView(),
        processRun: { ...makeView().processRun, status: "killed" },
      })),
    };
    const result = await execute(manager, { action: "kill", processRunId: "process_1" });

    expect(manager.kill).toHaveBeenCalledWith({
      id: "process_1",
      ownerAgentId: "agent_1",
      suppressCompletionNotice: true,
    });
    expect(result.content[0]).toMatchObject({
      type: "json",
      json: { process: { status: "killed" } },
    });
  });

  test("keeps the available cursor when a poll has no new output", async () => {
    const view = makeView();
    const manager = {
      get: vi.fn(() => ({ ...view, output: { ...view.output, chunks: [] } })),
    };
    const result = await execute(manager, {
      action: "poll",
      processRunId: "process_1",
      afterCursor: 304,
    });

    expect(result.content[0]).toMatchObject({
      type: "json",
      json: { output: { chunks: [], nextCursor: 304, hasMore: false } },
    });
  });

  test("returns corrective guidance when an action is missing processRunId", async () => {
    await expect(execute({ get: vi.fn() }, { action: "log" })).rejects.toMatchObject({
      kind: "recoverable_error",
      details: {
        code: "process_run_id_required",
        action: "log",
      },
    });
  });
});

async function execute(manager: object, args: Record<string, unknown>) {
  const registry = new ToolRegistry([createProcessTool()]);
  return await registry.execute(
    "process",
    {
      sessionId: "sess_1",
      conversationId: "conv_1",
      sessionPurpose: "chat",
      ownerAgentId: "agent_1",
      agentKind: "main",
      securityConfig: DEFAULT_CONFIG.security,
      storage: null as never,
      shellProcesses: manager as never,
    },
    args,
  );
}

function makeView(): ShellProcessView {
  return {
    processRun: {
      id: "process_1",
      ownerAgentId: "agent_1",
      sourceSessionId: "sess_1",
      conversationId: "conv_1",
      branchId: "branch_1",
      toolCallId: "tool_1",
      sourceRunId: "run_1",
      commandPreview: "node server.js",
      commandHash: "hash",
      cwd: "/tmp/work",
      sandboxMode: "sandboxed",
      status: "running",
      pid: 42,
      timeoutMs: null,
      notifyOnExit: "next_turn",
      startedAt: "2026-08-07T00:00:00.000Z",
      handedOffAt: "2026-08-07T00:00:01.000Z",
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      exitSignal: null,
      exitReason: null,
      errorText: null,
      stdoutChars: 304,
      stderrChars: 0,
      outputTail: "",
      outputChunksJson: null,
      outputTruncated: false,
      notificationStatus: "none",
    },
    output: {
      chunks: [{ cursorStart: 4, cursorEnd: 304, stream: "stdout", text: "x".repeat(300) }],
      nextCursor: 304,
      truncatedBefore: false,
      outputTruncated: false,
    },
  };
}
