import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  type ShellCommandHandle,
  type ShellCommandResult,
  ShellProcessManager,
} from "@/src/runtime/shell-process-manager.js";
import { ShellProcessRunsRepo } from "@/src/storage/repos/shell-process-runs.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";
import { seedConversationAndAgentFixture } from "@/tests/tools/helpers.js";

describe("ShellProcessManager", () => {
  let database: TestDatabaseHandle | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (database != null) {
      await destroyTestDatabase(database);
      database = null;
    }
  });

  async function prepare() {
    database = await createTestDatabase(import.meta.url);
    seedConversationAndAgentFixture(database);
    database.storage.sqlite.exec(`
      INSERT INTO sessions (
        id, conversation_id, branch_id, owner_agent_id, purpose, created_at, updated_at
      ) VALUES (
        'sess_1', 'conv_1', 'branch_1', 'agent_1', 'chat',
        '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z'
      );
    `);
    return new ShellProcessManager(database.storage.db);
  }

  function requireDatabase(): TestDatabaseHandle {
    if (database == null) {
      throw new Error("Expected the test database to be initialized.");
    }
    return database;
  }

  test("captures incremental output and notifies only after handoff", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle();
    const notices: string[] = [];
    manager.attachCompletionHandler((run) => notices.push(run.id));

    const started = await manager.start(
      makeStartInput(() => Promise.resolve(controlled.handle), { notifyOnExit: "next_turn" }),
    );
    controlled.stdout.write("ready\n");
    controlled.stderr.write("warning\n");
    const handedOff = manager.markHandedOff(started.processRun.id, "agent_1");
    expect(handedOff.processRun.status).toBe("running");

    const firstPoll = manager.get({
      id: started.processRun.id,
      ownerAgentId: "agent_1",
      afterCursor: 0,
    });
    expect(firstPoll.output.chunks.map((chunk) => [chunk.stream, chunk.text])).toEqual([
      ["stdout", "ready\n"],
      ["stderr", "warning\n"],
    ]);

    controlled.stdout.write("done\n");
    controlled.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
    const settled = await manager.waitForSettlement({
      id: started.processRun.id,
      ownerAgentId: "agent_1",
      waitMs: 1_000,
    });
    expect(settled.processRun).toMatchObject({
      status: "completed",
      exitCode: 0,
      notificationStatus: "pending",
    });
    expect(settled.output.chunks.at(-1)?.text).toBe("done\n");
    expect(notices).toEqual([started.processRun.id]);

    const coldManager = new ShellProcessManager(requireDatabase().storage.db);
    const completeOutput = coldManager.get({
      id: started.processRun.id,
      ownerAgentId: "agent_1",
      afterCursor: 0,
    });
    expect(completeOutput.output.chunks.map((chunk) => [chunk.stream, chunk.text])).toEqual([
      ["stdout", "ready\n"],
      ["stderr", "warning\n"],
      ["stdout", "done\n"],
    ]);
    const incremental = coldManager.get({
      id: started.processRun.id,
      ownerAgentId: "agent_1",
      afterCursor: 14,
    });
    expect(incremental.output).toMatchObject({
      chunks: [{ cursorStart: 14, cursorEnd: 19, text: "done\n" }],
      nextCursor: 19,
    });
  });

  test("does not create a duplicate completion notice when the command settles before handoff", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle();
    const notices: string[] = [];
    manager.attachCompletionHandler((run) => notices.push(run.id));
    const started = await manager.start(
      makeStartInput(() => Promise.resolve(controlled.handle), { notifyOnExit: "wake" }),
    );

    controlled.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
    const settled = await manager.waitForSettlement({
      id: started.processRun.id,
      ownerAgentId: "agent_1",
      waitMs: 1_000,
    });

    expect(settled.processRun.notificationStatus).toBe("none");
    expect(notices).toEqual([]);
  });

  test("applies timeout to the total managed lifetime and terminates the process tree", async () => {
    vi.useFakeTimers();
    const manager = await prepare();
    const controlled = createControlledHandle({ resolveOnTerminate: true });
    const started = await manager.start(
      makeStartInput(() => Promise.resolve(controlled.handle), { timeoutMs: 250 }),
    );
    manager.markHandedOff(started.processRun.id, "agent_1");

    await vi.advanceTimersByTimeAsync(250);
    const settledPromise = manager.waitForSettlement({
      id: started.processRun.id,
      ownerAgentId: "agent_1",
      waitMs: 1_000,
    });
    await vi.runAllTimersAsync();
    const settled = await settledPromise;

    expect(controlled.terminate).toHaveBeenCalledWith({ graceMs: 5_000 });
    expect(settled.processRun).toMatchObject({
      status: "timed_out",
      exitReason: "timeout",
    });
  });

  test("turns a hung process startup into a recoverable startup timeout", async () => {
    vi.useFakeTimers();
    const manager = await prepare();
    const starting = manager.start(
      makeStartInput(
        (signal) =>
          new Promise<ShellCommandHandle>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
      ),
    );
    const rejected = expect(starting).rejects.toMatchObject({
      details: {
        code: "shell_process_startup_timeout",
        startupTimeoutMs: 15_000,
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(
      new ShellProcessRunsRepo(requireDatabase().storage.db).listByOwner("agent_1", 1)[0],
    ).toMatchObject({
      status: "failed",
      exitReason: "startup_timeout",
      notificationStatus: "none",
    });
  });

  test("enforces the startup deadline even when the starter ignores abort", async () => {
    vi.useFakeTimers();
    const manager = await prepare();
    const starting = manager.start(makeStartInput(() => new Promise<ShellCommandHandle>(() => {})));
    const rejected = expect(starting).rejects.toMatchObject({
      details: {
        code: "shell_process_startup_timeout",
        startupTimeoutMs: 15_000,
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(
      new ShellProcessRunsRepo(requireDatabase().storage.db).listByOwner("agent_1", 1)[0],
    ).toMatchObject({
      status: "failed",
      exitReason: "startup_timeout",
    });
  });

  test("kill and shutdown terminate attached managed processes", async () => {
    const manager = await prepare();
    const first = createControlledHandle({ resolveOnTerminate: true });
    const second = createControlledHandle({ resolveOnTerminate: true });
    const firstRun = await manager.start(makeStartInput(() => Promise.resolve(first.handle)));
    const secondRun = await manager.start(makeStartInput(() => Promise.resolve(second.handle)));

    const killed = await manager.kill({ id: firstRun.processRun.id, ownerAgentId: "agent_1" });
    expect(killed.processRun).toMatchObject({ status: "killed", exitReason: "requested" });
    await manager.shutdown();

    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(
      new ShellProcessRunsRepo(requireDatabase().storage.db).getById(secondRun.processRun.id),
    ).toMatchObject({ status: "killed", exitReason: "runtime_shutdown" });
  });

  test("settles quietly when the owning conversation is deleted before process exit", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle();
    const notices: string[] = [];
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", captureUnhandledRejection);

    try {
      const started = await manager.start(makeStartInput(() => Promise.resolve(controlled.handle)));
      manager.markHandedOff(started.processRun.id, "agent_1");
      manager.attachCompletionHandler((run) => notices.push(run.id));

      requireDatabase()
        .storage.sqlite.prepare("DELETE FROM conversations WHERE id = ?")
        .run("conv_1");
      controlled.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        new ShellProcessRunsRepo(requireDatabase().storage.db).getById(started.processRun.id),
      ).toBeNull();
      expect(notices).toEqual([]);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandledRejection);
      await manager.shutdown();
    }
  });

  test("marks active records lost after restart without signaling a reused pid", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle();
    const started = await manager.start(makeStartInput(() => Promise.resolve(controlled.handle)));
    manager.markHandedOff(started.processRun.id, "agent_1");

    const recovered = new ShellProcessManager(requireDatabase().storage.db);
    const deliveries: Array<{ processRunId: string; allowWake: boolean }> = [];
    recovered.attachCompletionHandler((processRun, delivery) => {
      deliveries.push({ processRunId: processRun.id, allowWake: delivery.allowWake });
    });
    recovered.recoverAfterRestart();
    const record = new ShellProcessRunsRepo(requireDatabase().storage.db).getById(
      started.processRun.id,
    );
    expect(record).toMatchObject({
      status: "lost",
      exitReason: "runtime_restart",
      notificationStatus: "pending",
    });
    expect(controlled.terminate).not.toHaveBeenCalled();
    expect(deliveries).toEqual([{ processRunId: started.processRun.id, allowWake: false }]);

    controlled.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
    await manager.shutdown();
  });

  test("keeps legacy none notification rows silent after restart", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle();
    const started = await manager.start(makeStartInput(() => Promise.resolve(controlled.handle)));
    manager.markHandedOff(started.processRun.id, "agent_1");
    requireDatabase()
      .storage.sqlite.prepare("UPDATE shell_process_runs SET notify_on_exit = 'none' WHERE id = ?")
      .run(started.processRun.id);

    const recovered = new ShellProcessManager(requireDatabase().storage.db);
    recovered.recoverAfterRestart();

    expect(
      new ShellProcessRunsRepo(requireDatabase().storage.db).getById(started.processRun.id),
    ).toMatchObject({
      status: "lost",
      exitReason: "runtime_restart",
      notificationStatus: "none",
    });

    controlled.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
    await manager.shutdown();
  });

  test("does not expose process ids across owners", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle({ resolveOnTerminate: true });
    const started = await manager.start(makeStartInput(() => Promise.resolve(controlled.handle)));

    expect(() => manager.get({ id: started.processRun.id, ownerAgentId: "another-agent" })).toThrow(
      /not found/i,
    );
    await manager.shutdown();
  });

  test("cleans up a process whose startup races with runtime shutdown", async () => {
    const manager = await prepare();
    const controlled = createControlledHandle({ resolveOnTerminate: true });
    let releaseStart!: (handle: ShellCommandHandle) => void;
    const startHandle = new Promise<ShellCommandHandle>((resolve) => {
      releaseStart = resolve;
    });
    const starting = manager.start(makeStartInput(() => startHandle));
    const rejected = expect(starting).rejects.toMatchObject({
      details: { code: "shell_process_manager_closing" },
    });

    manager.beginShutdown();
    await manager.shutdown();
    await rejected;
    releaseStart(controlled.handle);

    await vi.waitFor(() => {
      expect(controlled.terminate).toHaveBeenCalledOnce();
    });
    expect(
      new ShellProcessRunsRepo(requireDatabase().storage.db).listByOwner("agent_1", 1)[0],
    ).toMatchObject({
      status: "killed",
      exitReason: "runtime_shutdown",
      notificationStatus: "none",
    });
  });
});

function makeStartInput(
  startHandle: (signal: AbortSignal) => Promise<ShellCommandHandle>,
  overrides: { timeoutMs?: number | null; notifyOnExit?: "next_turn" | "wake" } = {},
) {
  return {
    ownerAgentId: "agent_1",
    sourceSessionId: "sess_1",
    command: "node server.js",
    cwd: "/tmp/work",
    sandboxMode: "sandboxed" as const,
    timeoutMs: overrides.timeoutMs === undefined ? 30_000 : overrides.timeoutMs,
    notifyOnExit: overrides.notifyOnExit ?? ("next_turn" as const),
    startHandle,
  };
}

function createControlledHandle(options: { resolveOnTerminate?: boolean } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolve!: (result: ShellCommandResult) => void;
  const wait = new Promise<ShellCommandResult>((done) => {
    resolve = done;
  });
  const terminate = vi.fn(async () => {
    if (options.resolveOnTerminate === true) {
      resolve({ stdout: "", stderr: "", exitCode: null, signal: "SIGTERM" });
    }
  });
  return {
    stdout,
    stderr,
    resolve,
    terminate,
    handle: {
      pid: 4242,
      stdout,
      stderr,
      wait: () => wait,
      terminate,
    } satisfies ShellCommandHandle,
  };
}
