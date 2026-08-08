import { setTimeout as sleep } from "node:timers/promises";

import { SandboxManager } from "@danielwpz/sandbox-runtime";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ShellProcessManager } from "@/src/runtime/shell-process-manager.js";
import { type BashToolDetails, createBashTool } from "@/src/tools/bash.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createProcessTool } from "@/src/tools/process.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

describe("managed bash process integration", () => {
  let database: TestDatabaseHandle | null = null;
  let manager: ShellProcessManager | null = null;

  afterEach(async () => {
    await manager?.shutdown();
    manager = null;
    await SandboxManager.reset();
    if (database != null) {
      await destroyTestDatabase(database);
      database = null;
    }
  });

  test("covers real yield, handoff, polling, timeout, and kill flows", async () => {
    database = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(database);
    database.storage.sqlite.exec(`
      UPDATE agents SET kind = 'main' WHERE id = 'agent_1';
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at
      ) VALUES (
        'sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat',
        '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z'
      );
    `);
    await SandboxManager.initialize({
      filesystem: {
        readMode: "deny_only",
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      network: {
        mode: "deny_only",
        allowedDomains: [],
        deniedDomains: [],
      },
    });

    manager = new ShellProcessManager(database.storage.db);
    const registry = new ToolRegistry([createBashTool(), createProcessTool()]);
    const context = {
      sessionId: "sess_1",
      conversationId: "conv_1",
      ownerAgentId: "agent_1",
      agentKind: "main" as const,
      sessionPurpose: "chat" as const,
      cwd: process.cwd(),
      securityConfig: DEFAULT_CONFIG.security,
      storage: database.storage.db,
      shellProcesses: manager,
    };
    const command = `${JSON.stringify(process.execPath)} -e 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); console.log("CHILD_PID:" + child.pid); setInterval(() => {}, 1000)'`;

    const started = await registry.execute("bash", context, {
      command,
      background: true,
      timeoutSec: 2,
    });
    const details = started.details as BashToolDetails;
    expect(details).toMatchObject({
      processStatus: "running",
      backgrounded: true,
      timeoutMs: 2_000,
    });
    const processRunId = details.processRunId;
    expect(processRunId).toEqual(expect.any(String));
    expect(
      manager.get({ id: processRunId as string, ownerAgentId: "agent_1" }).processRun,
    ).toMatchObject({ notifyOnExit: "next_turn" });

    let childPid: number | null = null;
    for (let attempt = 0; attempt < 20 && childPid == null; attempt += 1) {
      const view = manager.get({ id: processRunId as string, ownerAgentId: "agent_1" });
      const output = view.output.chunks.map((chunk) => chunk.text).join("");
      const match = output.match(/CHILD_PID:(\d+)/u);
      childPid = match?.[1] == null ? null : Number.parseInt(match[1], 10);
      if (childPid == null) {
        await sleep(50);
      }
    }
    expect(childPid).toEqual(expect.any(Number));

    const polled = await registry.execute("process", context, {
      action: "poll",
      processRunId,
      afterCursor: 0,
    });
    expect(polled.content[0]).toMatchObject({
      type: "json",
      json: {
        process: { processRunId, status: "running" },
        output: { nextCursor: expect.any(Number) },
      },
    });

    const settled = await manager.waitForSettlement({
      id: processRunId as string,
      ownerAgentId: "agent_1",
      waitMs: 5_000,
    });
    expect(settled.processRun).toMatchObject({
      status: "timed_out",
      exitReason: "timeout",
    });
    await sleep(100);
    expect(isProcessAlive(childPid as number)).toBe(false);

    const yielded = await registry.execute("bash", context, {
      command: `${JSON.stringify(process.execPath)} -e 'setTimeout(() => console.log("YIELD_DONE"), 100)'`,
      yieldMs: 1_000,
      timeoutSec: 5,
    });
    expect(yielded.details).toMatchObject({
      processStatus: "completed",
      backgrounded: false,
      exitCode: 0,
    });
    expect(yielded.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("YIELD_DONE"),
    });
    expect(
      manager.get({
        id: (yielded.details as BashToolDetails).processRunId as string,
        ownerAgentId: "agent_1",
      }).processRun,
    ).toMatchObject({ notifyOnExit: "wake", notificationStatus: "none" });

    const background = await registry.execute("bash", context, {
      command: `${JSON.stringify(process.execPath)} -e 'console.log("WORKER_READY"); setInterval(() => {}, 1000)'`,
      background: true,
      timeoutSec: 10,
      notifyOnExit: "wake",
    });
    const backgroundId = (background.details as BashToolDetails).processRunId;
    expect(
      manager.get({ id: backgroundId as string, ownerAgentId: "agent_1" }).processRun,
    ).toMatchObject({ notifyOnExit: "wake" });
    const killed = await registry.execute("process", context, {
      action: "kill",
      processRunId: backgroundId,
    });
    expect(killed.content[0]).toMatchObject({
      type: "json",
      json: {
        process: {
          processRunId: backgroundId,
          status: "killed",
          exitReason: "requested",
        },
      },
    });
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
