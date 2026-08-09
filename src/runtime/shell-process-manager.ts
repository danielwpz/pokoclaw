import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { ShellProcessRunsRepo } from "@/src/storage/repos/shell-process-runs.repo.js";
import type { ShellProcessRun } from "@/src/storage/schema/types.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";

const logger = createSubsystemLogger("shell-process-manager");

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_ACTIVE_PROCESSES = 64;
const MAX_ACTIVE_PROCESSES_PER_OWNER = 8;
const MAX_LIVE_OUTPUT_CHARS = 200_000;
const MAX_PERSISTED_OUTPUT_CHARS = 32_000;
const MAX_ERROR_TEXT_CHARS = 2_000;
const COMMAND_PREVIEW_CHARS = 240;

export type ShellProcessStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "killed"
  | "lost";

export type ShellProcessNotifyOnExit = "next_turn" | "wake";
export type ShellProcessExitReason = "timeout" | "requested" | "runtime_shutdown";

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ShellCommandHandle {
  pid: number | null;
  stdout: Readable | null;
  stderr: Readable | null;
  wait(): Promise<ShellCommandResult>;
  terminate(options?: { graceMs?: number }): Promise<void>;
}

export interface StartManagedShellProcessInput {
  ownerAgentId: string;
  sourceSessionId: string;
  toolCallId?: string | null;
  sourceRunId?: string | null;
  command: string;
  cwd: string;
  sandboxMode: "sandboxed" | "full_access";
  timeoutMs: number | null;
  notifyOnExit: ShellProcessNotifyOnExit;
  startHandle(signal: AbortSignal): Promise<ShellCommandHandle>;
}

export interface ShellProcessOutputChunk {
  cursorStart: number;
  cursorEnd: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ShellProcessOutputView {
  chunks: ShellProcessOutputChunk[];
  nextCursor: number;
  truncatedBefore: boolean;
  outputTruncated: boolean;
}

export interface ShellProcessView {
  processRun: ShellProcessRun;
  output: ShellProcessOutputView;
  settlementError?: unknown;
}

export interface ShellProcessCompletionDelivery {
  allowWake: boolean;
}

export type ShellProcessCompletionHandler = (
  processRun: ShellProcessRun,
  delivery: ShellProcessCompletionDelivery,
) => void;

interface LiveShellProcess {
  id: string;
  ownerAgentId: string;
  startedAtMs: number;
  handle: ShellCommandHandle;
  output: ShellProcessOutputBuffer;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  requestedExitReason: ShellProcessExitReason | null;
  notificationSuppressed: boolean;
  settlement: Promise<ShellProcessRun | null>;
}

type ShellProcessStartupCancellationReason = "timeout" | "runtime_shutdown";

interface StartingShellProcess {
  ownerAgentId: string;
  abortController: AbortController;
  cancellation: Promise<never>;
  cancellationReason: ShellProcessStartupCancellationReason | null;
  cancel(reason: ShellProcessStartupCancellationReason): void;
  completion: Promise<void>;
  finish(): void;
}

export class ShellProcessManager {
  private readonly repo: ShellProcessRunsRepo;
  private readonly starting = new Map<string, StartingShellProcess>();
  private readonly active = new Map<string, LiveShellProcess>();
  private readonly settlementErrors = new Map<string, unknown>();
  private readonly settlementOutputs = new Map<string, ShellProcessOutputView>();
  private completionHandler: ShellProcessCompletionHandler | null = null;
  private closing = false;

  constructor(private readonly storage: StorageDb) {
    this.repo = new ShellProcessRunsRepo(storage);
  }

  attachCompletionHandler(handler: ShellProcessCompletionHandler): void {
    this.completionHandler = handler;
  }

  recoverAfterRestart(): void {
    const recoveredAt = new Date();
    for (const processRun of this.repo.listActive()) {
      const startedAtMs = parseTimestamp(processRun.startedAt, recoveredAt.getTime());
      this.repo.settle({
        id: processRun.id,
        status: "lost",
        finishedAt: recoveredAt,
        durationMs: Math.max(0, recoveredAt.getTime() - startedAtMs),
        exitCode: processRun.exitCode,
        exitSignal: processRun.exitSignal,
        exitReason: "runtime_restart",
        errorText:
          "Pokoclaw restarted while this managed shell process was still recorded as active.",
        stdoutChars: processRun.stdoutChars,
        stderrChars: processRun.stderrChars,
        outputTail: processRun.outputTail,
        outputTruncated: processRun.outputTruncated,
        // Older local development builds could persist notify_on_exit='none'. Keep those
        // rows silent during recovery even though new tool calls expose only the two
        // supported delivery policies.
        notificationStatus:
          processRun.handedOffAt == null || processRun.notifyOnExit === "none" ? "none" : "pending",
      });
    }
    // Restart recovery may happen months after the original work. Preserve the
    // completion as next-turn context, but never start an Agent run from boot.
    this.dispatchPendingNotifications({ allowWake: false });
  }

  dispatchPendingNotifications(
    delivery: ShellProcessCompletionDelivery = { allowWake: true },
  ): void {
    if (this.completionHandler == null) {
      return;
    }
    for (const processRun of this.repo.listPendingNotifications()) {
      this.deliverCompletion(processRun, delivery);
    }
  }

  async start(input: StartManagedShellProcessInput): Promise<ShellProcessView> {
    this.assertCanStart(input.ownerAgentId);

    const session = new SessionsRepo(this.storage).getById(input.sourceSessionId);
    if (session == null) {
      throw toolRecoverableError("Cannot start a managed shell process for an unknown session.", {
        code: "shell_process_source_session_not_found",
        sourceSessionId: input.sourceSessionId,
      });
    }
    if (session.ownerAgentId !== input.ownerAgentId) {
      throw toolRecoverableError(
        "Cannot start a managed shell process for a session owned by another agent.",
        {
          code: "shell_process_owner_mismatch",
          sourceSessionId: input.sourceSessionId,
        },
      );
    }

    const id = randomUUID();
    const startedAt = new Date();
    this.repo.create({
      id,
      ownerAgentId: input.ownerAgentId,
      sourceSessionId: input.sourceSessionId,
      conversationId: session.conversationId,
      branchId: session.branchId,
      toolCallId: input.toolCallId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      commandPreview: renderCommandPreview(input.command),
      commandHash: createHash("sha256").update(input.command).digest("hex"),
      cwd: input.cwd,
      sandboxMode: input.sandboxMode,
      timeoutMs: input.timeoutMs,
      notifyOnExit: input.notifyOnExit,
      startedAt,
    });

    const starting = createStartingShellProcess(input.ownerAgentId);
    this.starting.set(id, starting);
    const startPromise = invokeStartHandle(input.startHandle, starting.abortController.signal);
    const startupTimeout = setTimeout(() => starting.cancel("timeout"), DEFAULT_STARTUP_TIMEOUT_MS);

    let handle: ShellCommandHandle | null = null;
    try {
      handle = await Promise.race([startPromise, starting.cancellation]);
      if (starting.cancellationReason != null) {
        throw new Error("Managed shell process startup was cancelled.");
      }
    } catch (error) {
      const finishedAt = new Date();
      const cancellationReason = starting.cancellationReason;
      if (cancellationReason != null) {
        if (handle == null) {
          scheduleLateHandleCleanup(startPromise, id);
        } else {
          await cleanupStartedHandle(handle, id);
        }
      }
      this.repo.settle({
        id,
        status: cancellationReason === "runtime_shutdown" ? "killed" : "failed",
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        exitReason:
          cancellationReason === "timeout"
            ? "startup_timeout"
            : cancellationReason === "runtime_shutdown"
              ? "runtime_shutdown"
              : "start_failed",
        errorText:
          cancellationReason === "runtime_shutdown"
            ? "Pokoclaw began shutting down while this managed process was starting."
            : renderErrorText(error),
        stdoutChars: 0,
        stderrChars: 0,
        outputTail: "",
        outputTruncated: false,
        notificationStatus: "none",
      });
      if (cancellationReason === "timeout") {
        throw toolRecoverableError(
          `The managed shell process did not start within ${DEFAULT_STARTUP_TIMEOUT_MS}ms.`,
          {
            code: "shell_process_startup_timeout",
            startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
          },
        );
      }
      if (cancellationReason === "runtime_shutdown") {
        throw managerClosingError();
      }
      throw error;
    } finally {
      clearTimeout(startupTimeout);
      this.starting.delete(id);
      starting.finish();
    }

    if (this.closing) {
      await handle.terminate({ graceMs: DEFAULT_TERMINATION_GRACE_MS }).catch(() => {});
      const result = await handle.wait().catch(() => null);
      const finishedAt = new Date();
      const capturedOutput = buildOutputViewFromResult(result);
      const persistedOutput = readOutputViewAfter(
        capturedOutput,
        Math.max(0, capturedOutput.nextCursor - MAX_PERSISTED_OUTPUT_CHARS),
      );
      this.repo.settle({
        id,
        status: "killed",
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        exitCode: result?.exitCode ?? null,
        exitSignal: result?.signal ?? null,
        exitReason: "runtime_shutdown",
        errorText: "Pokoclaw began shutting down while this managed process was starting.",
        stdoutChars: result?.stdout.length ?? 0,
        stderrChars: result?.stderr.length ?? 0,
        outputTail: renderOutputChunkText(persistedOutput.chunks),
        outputChunksJson: serializePersistedOutputChunks(persistedOutput.chunks),
        outputTruncated:
          (result?.stdout.length ?? 0) + (result?.stderr.length ?? 0) > MAX_PERSISTED_OUTPUT_CHARS,
        notificationStatus: "none",
      });
      throw managerClosingError();
    }

    const output = new ShellProcessOutputBuffer(MAX_LIVE_OUTPUT_CHARS);
    handle.stdout?.on("data", (chunk: Buffer | string) => {
      output.append("stdout", toUtf8(chunk));
    });
    handle.stderr?.on("data", (chunk: Buffer | string) => {
      output.append("stderr", toUtf8(chunk));
    });
    this.repo.markRunning({ id, pid: handle.pid });

    const live: LiveShellProcess = {
      id,
      ownerAgentId: input.ownerAgentId,
      startedAtMs: startedAt.getTime(),
      handle,
      output,
      timeoutHandle: null,
      requestedExitReason: null,
      notificationSuppressed: false,
      settlement: new Promise<ShellProcessRun | null>(() => {}),
    };
    live.settlement = this.settleWhenFinished(live);
    // Handed-off processes are intentionally fire-and-forget. Keep their
    // settlement failures observable without allowing an unhandled rejection
    // to terminate the always-on runtime; explicit waiters still observe the
    // original promise rejection.
    void live.settlement.catch((error: unknown) => {
      logger.error("managed shell process settlement failed", {
        processRunId: live.id,
        ownerAgentId: live.ownerAgentId,
        error: renderErrorText(error),
      });
    });
    this.active.set(id, live);

    if (input.timeoutMs != null) {
      live.timeoutHandle = setTimeout(() => {
        void this.requestTermination(live, "timeout");
      }, input.timeoutMs);
    }

    logger.info("managed shell process started", {
      processRunId: id,
      ownerAgentId: input.ownerAgentId,
      sourceSessionId: input.sourceSessionId,
      pid: handle.pid,
      timeoutMs: input.timeoutMs,
      sandboxMode: input.sandboxMode,
    });

    return this.requireView(id, input.ownerAgentId);
  }

  markHandedOff(id: string, ownerAgentId: string): ShellProcessView {
    this.requireOwned(id, ownerAgentId);
    this.repo.markHandedOff(id);
    return this.requireView(id, ownerAgentId);
  }

  suppressCompletionNotice(id: string, ownerAgentId: string): ShellProcessView {
    const processRun = this.requireOwned(id, ownerAgentId);
    const live = this.active.get(id);
    if (live?.ownerAgentId === ownerAgentId) {
      live.notificationSuppressed = true;
    }
    if (live != null || processRun.notificationStatus === "pending") {
      this.repo.markNotificationSuppressed(id);
    }
    return this.requireView(id, ownerAgentId);
  }

  async waitForSettlement(input: {
    id: string;
    ownerAgentId: string;
    waitMs: number;
    abortSignal?: AbortSignal;
  }): Promise<ShellProcessView> {
    const live = this.active.get(input.id);
    if (live == null) {
      return this.requireView(input.id, input.ownerAgentId);
    }
    if (live.ownerAgentId !== input.ownerAgentId) {
      throw unknownProcessError(input.id);
    }

    await waitForSettlementOrDeadline(live.settlement, input.waitMs, input.abortSignal);
    return this.requireView(input.id, input.ownerAgentId);
  }

  list(ownerAgentId: string, limit = 20): ShellProcessRun[] {
    return this.repo.listByOwner(ownerAgentId, Math.max(1, Math.min(50, limit)));
  }

  get(input: { id: string; ownerAgentId: string; afterCursor?: number }): ShellProcessView {
    return this.requireView(input.id, input.ownerAgentId, input.afterCursor);
  }

  async kill(input: {
    id: string;
    ownerAgentId: string;
    suppressCompletionNotice?: boolean;
  }): Promise<ShellProcessView> {
    const live = this.active.get(input.id);
    if (live == null || live.ownerAgentId !== input.ownerAgentId) {
      const processRun = this.requireOwned(input.id, input.ownerAgentId);
      if (processRun.status !== "starting" && processRun.status !== "running") {
        if (
          input.suppressCompletionNotice === true &&
          processRun.notificationStatus === "pending"
        ) {
          this.repo.markNotificationSuppressed(input.id);
        }
        return this.requireView(input.id, input.ownerAgentId);
      }
      throw toolRecoverableError(
        "This shell process is recorded as active but is not attached to the current runtime.",
        {
          code: "shell_process_not_attached",
          processRunId: input.id,
        },
      );
    }

    if (input.suppressCompletionNotice === true) {
      live.notificationSuppressed = true;
    }
    await this.requestTermination(live, "requested");
    await live.settlement;
    return this.requireView(input.id, input.ownerAgentId);
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    const starting = [...this.starting.values()].map((process) => process.completion);
    const active = [...this.active.values()];
    await Promise.allSettled(
      active.map((live) => this.requestTermination(live, "runtime_shutdown")),
    );
    await Promise.allSettled([...starting, ...active.map((live) => live.settlement)]);
    logger.info("managed shell process manager shutdown complete", {
      terminatedCount: active.length,
      cancelledStartupCount: starting.length,
    });
  }

  beginShutdown(): void {
    this.closing = true;
    for (const process of this.starting.values()) {
      process.cancel("runtime_shutdown");
    }
  }

  private assertCanStart(ownerAgentId: string): void {
    if (this.closing) {
      throw managerClosingError();
    }
    if (this.active.size + this.starting.size >= MAX_ACTIVE_PROCESSES) {
      throw processLimitError("global", MAX_ACTIVE_PROCESSES);
    }
    const ownerActive =
      [...this.active.values()].filter((process) => process.ownerAgentId === ownerAgentId).length +
      [...this.starting.values()].filter((process) => process.ownerAgentId === ownerAgentId).length;
    if (ownerActive >= MAX_ACTIVE_PROCESSES_PER_OWNER) {
      throw processLimitError("owner", MAX_ACTIVE_PROCESSES_PER_OWNER);
    }
  }

  private async requestTermination(
    live: LiveShellProcess,
    reason: ShellProcessExitReason,
  ): Promise<void> {
    live.requestedExitReason ??= reason;
    if (live.timeoutHandle != null) {
      clearTimeout(live.timeoutHandle);
      live.timeoutHandle = null;
    }
    try {
      await live.handle.terminate({ graceMs: DEFAULT_TERMINATION_GRACE_MS });
    } catch (error) {
      logger.warn("managed shell process termination failed", {
        processRunId: live.id,
        reason,
        error: renderErrorText(error),
      });
    }
  }

  private async settleWhenFinished(live: LiveShellProcess): Promise<ShellProcessRun | null> {
    let result: ShellCommandResult | null = null;
    let waitError: unknown = null;
    try {
      result = await live.handle.wait();
    } catch (error) {
      waitError = error;
      this.settlementErrors.set(live.id, error);
      while (this.settlementErrors.size > 100) {
        const oldest = this.settlementErrors.keys().next().value;
        if (oldest == null) {
          break;
        }
        this.settlementErrors.delete(oldest);
      }
    }

    if (live.timeoutHandle != null) {
      clearTimeout(live.timeoutHandle);
      live.timeoutHandle = null;
    }

    const finishedAt = new Date();
    const status = resolveTerminalStatus({
      requestedExitReason: live.requestedExitReason,
      result,
      waitError,
    });
    const outputSnapshot = live.output.snapshot();
    this.settlementOutputs.set(live.id, live.output.readAfter(0));
    while (this.settlementOutputs.size > 100) {
      const oldest = this.settlementOutputs.keys().next().value;
      if (oldest == null) {
        break;
      }
      this.settlementOutputs.delete(oldest);
    }
    const totalOutputChars = outputSnapshot.stdoutChars + outputSnapshot.stderrChars;
    const persistedOutput = live.output.readAfter(
      Math.max(0, totalOutputChars - MAX_PERSISTED_OUTPUT_CHARS),
    );
    let settled: ShellProcessRun | null = null;
    try {
      const processBeforeSettlement = this.repo.getById(live.id);
      this.repo.settle({
        id: live.id,
        status,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - live.startedAtMs),
        exitCode: result?.exitCode ?? null,
        exitSignal: result?.signal ?? null,
        exitReason:
          live.requestedExitReason ?? (waitError == null ? "process_exit" : "wait_failed"),
        errorText: waitError == null ? null : renderErrorText(waitError),
        stdoutChars: outputSnapshot.stdoutChars,
        stderrChars: outputSnapshot.stderrChars,
        outputTail: renderOutputChunkText(persistedOutput.chunks),
        outputChunksJson: serializePersistedOutputChunks(persistedOutput.chunks),
        outputTruncated:
          outputSnapshot.outputTruncated || totalOutputChars > MAX_PERSISTED_OUTPUT_CHARS,
        notificationStatus: live.notificationSuppressed
          ? "suppressed"
          : processBeforeSettlement?.handedOffAt == null
            ? "none"
            : "pending",
      });
      settled = this.repo.getById(live.id);
    } finally {
      this.active.delete(live.id);
    }
    if (settled == null) {
      this.settlementOutputs.delete(live.id);
      this.settlementErrors.delete(live.id);
      logger.warn("managed shell process record disappeared before settlement", {
        processRunId: live.id,
        ownerAgentId: live.ownerAgentId,
        status,
      });
      return null;
    }

    logger.info("managed shell process settled", {
      processRunId: live.id,
      ownerAgentId: live.ownerAgentId,
      status,
      exitCode: settled.exitCode,
      exitSignal: settled.exitSignal,
      exitReason: settled.exitReason,
      durationMs: settled.durationMs,
      outputTruncated: settled.outputTruncated,
    });
    if (settled.notificationStatus === "pending") {
      this.deliverCompletion(settled, { allowWake: true });
    }
    return settled;
  }

  private deliverCompletion(
    processRun: ShellProcessRun,
    delivery: ShellProcessCompletionDelivery,
  ): void {
    try {
      this.completionHandler?.(processRun, delivery);
    } catch (error) {
      logger.error("managed shell process completion handler failed", {
        processRunId: processRun.id,
        error: renderErrorText(error),
      });
    }
  }

  private requireOwned(id: string, ownerAgentId: string): ShellProcessRun {
    const processRun = this.repo.getOwned(id, ownerAgentId);
    if (processRun == null) {
      throw unknownProcessError(id);
    }
    return processRun;
  }

  private requireView(id: string, ownerAgentId: string, afterCursor = 0): ShellProcessView {
    const processRun = this.requireOwned(id, ownerAgentId);
    const live = this.active.get(id);
    return {
      processRun,
      output:
        live == null && this.settlementOutputs.has(id)
          ? readOutputViewAfter(
              this.settlementOutputs.get(id) as ShellProcessOutputView,
              afterCursor,
            )
          : live == null
            ? readPersistedOutputAfter(processRun, afterCursor)
            : live.output.readAfter(afterCursor),
      ...(this.settlementErrors.has(id) ? { settlementError: this.settlementErrors.get(id) } : {}),
    };
  }
}

interface OutputSnapshot {
  chunks: ShellProcessOutputChunk[];
  stdoutChars: number;
  stderrChars: number;
  outputTruncated: boolean;
  renderTail(maxChars: number): string;
}

class ShellProcessOutputBuffer {
  private chunks: ShellProcessOutputChunk[] = [];
  private retainedChars = 0;
  private cursor = 0;
  private stdoutChars = 0;
  private stderrChars = 0;
  private truncated = false;

  constructor(private readonly maxChars: number) {}

  append(stream: "stdout" | "stderr", text: string): void {
    if (text.length === 0) {
      return;
    }
    const cursorStart = this.cursor;
    this.cursor += text.length;
    if (stream === "stdout") {
      this.stdoutChars += text.length;
    } else {
      this.stderrChars += text.length;
    }
    this.chunks.push({ cursorStart, cursorEnd: this.cursor, stream, text });
    this.retainedChars += text.length;
    this.trim();
  }

  readAfter(afterCursor: number): ShellProcessOutputView {
    const normalizedCursor = Math.max(0, Math.floor(afterCursor));
    const firstCursor = this.chunks[0]?.cursorStart ?? this.cursor;
    const chunks = this.chunks.flatMap((chunk) => {
      if (chunk.cursorEnd <= normalizedCursor) {
        return [];
      }
      if (chunk.cursorStart >= normalizedCursor) {
        return [{ ...chunk }];
      }
      const offset = normalizedCursor - chunk.cursorStart;
      return [
        {
          ...chunk,
          cursorStart: normalizedCursor,
          text: chunk.text.slice(offset),
        },
      ];
    });
    return {
      chunks,
      nextCursor: this.cursor,
      truncatedBefore: normalizedCursor < firstCursor,
      outputTruncated: this.truncated,
    };
  }

  snapshot(): OutputSnapshot {
    const chunks = this.chunks.map((chunk) => ({ ...chunk }));
    return {
      chunks,
      stdoutChars: this.stdoutChars,
      stderrChars: this.stderrChars,
      outputTruncated: this.truncated,
      renderTail(maxChars: number): string {
        const rendered = chunks.map((chunk) => chunk.text).join("");
        return rendered.length <= maxChars ? rendered : rendered.slice(-maxChars);
      },
    };
  }

  private trim(): void {
    while (this.retainedChars > this.maxChars && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first == null) {
        return;
      }
      const overflow = this.retainedChars - this.maxChars;
      if (overflow >= first.text.length) {
        this.chunks.shift();
        this.retainedChars -= first.text.length;
      } else {
        first.text = first.text.slice(overflow);
        first.cursorStart += overflow;
        this.retainedChars -= overflow;
      }
      this.truncated = true;
    }
  }
}

function readOutputViewAfter(
  view: ShellProcessOutputView,
  afterCursor: number,
): ShellProcessOutputView {
  const normalizedCursor = Math.max(0, Math.floor(afterCursor));
  const chunks = view.chunks.flatMap((chunk) => {
    if (chunk.cursorEnd <= normalizedCursor) {
      return [];
    }
    if (chunk.cursorStart >= normalizedCursor) {
      return [{ ...chunk }];
    }
    const offset = normalizedCursor - chunk.cursorStart;
    return [
      {
        ...chunk,
        cursorStart: normalizedCursor,
        text: chunk.text.slice(offset),
      },
    ];
  });
  const firstCursor = view.chunks[0]?.cursorStart ?? view.nextCursor;
  return {
    chunks,
    nextCursor: view.nextCursor,
    truncatedBefore: view.truncatedBefore || normalizedCursor < firstCursor,
    outputTruncated: view.outputTruncated,
  };
}

function buildOutputViewFromResult(result: ShellCommandResult | null): ShellProcessOutputView {
  if (result == null) {
    return {
      chunks: [],
      nextCursor: 0,
      truncatedBefore: false,
      outputTruncated: false,
    };
  }

  const chunks: ShellProcessOutputChunk[] = [];
  let cursor = 0;
  if (result.stdout.length > 0) {
    chunks.push({
      cursorStart: cursor,
      cursorEnd: cursor + result.stdout.length,
      stream: "stdout",
      text: result.stdout,
    });
    cursor += result.stdout.length;
  }
  if (result.stderr.length > 0) {
    chunks.push({
      cursorStart: cursor,
      cursorEnd: cursor + result.stderr.length,
      stream: "stderr",
      text: result.stderr,
    });
    cursor += result.stderr.length;
  }
  return {
    chunks,
    nextCursor: cursor,
    truncatedBefore: false,
    outputTruncated: false,
  };
}

function renderOutputChunkText(chunks: readonly ShellProcessOutputChunk[]): string {
  return chunks.map((chunk) => chunk.text).join("");
}

function serializePersistedOutputChunks(chunks: readonly ShellProcessOutputChunk[]): string {
  return JSON.stringify({ version: 1, chunks });
}

function parsePersistedOutputChunks(value: string | null): ShellProcessOutputChunk[] | null {
  if (value == null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      chunks?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.chunks)) {
      return null;
    }

    const chunks: ShellProcessOutputChunk[] = [];
    let previousCursorEnd = -1;
    for (const candidate of parsed.chunks) {
      if (candidate == null || typeof candidate !== "object") {
        return null;
      }
      const chunk = candidate as Partial<ShellProcessOutputChunk>;
      if (
        !Number.isSafeInteger(chunk.cursorStart) ||
        !Number.isSafeInteger(chunk.cursorEnd) ||
        (chunk.cursorStart as number) < 0 ||
        (chunk.cursorEnd as number) < (chunk.cursorStart as number) ||
        (chunk.cursorStart as number) < previousCursorEnd ||
        (chunk.stream !== "stdout" && chunk.stream !== "stderr") ||
        typeof chunk.text !== "string" ||
        chunk.text.length !== (chunk.cursorEnd as number) - (chunk.cursorStart as number)
      ) {
        return null;
      }
      chunks.push(chunk as ShellProcessOutputChunk);
      previousCursorEnd = chunk.cursorEnd as number;
    }
    return chunks;
  } catch {
    return null;
  }
}

function readPersistedOutputAfter(
  processRun: ShellProcessRun,
  afterCursor: number,
): ShellProcessOutputView {
  const nextCursor = processRun.stdoutChars + processRun.stderrChars;
  const structuredChunks = parsePersistedOutputChunks(processRun.outputChunksJson);
  if (structuredChunks != null) {
    return readOutputViewAfter(
      {
        chunks: structuredChunks,
        nextCursor,
        truncatedBefore: false,
        outputTruncated: processRun.outputTruncated,
      },
      afterCursor,
    );
  }

  const tailStart = Math.max(0, nextCursor - processRun.outputTail.length);
  const normalizedCursor = Math.max(0, Math.floor(afterCursor));
  const cursorStart = Math.max(tailStart, Math.min(normalizedCursor, nextCursor));
  const text = processRun.outputTail.slice(cursorStart - tailStart);
  return {
    chunks:
      text.length === 0 ? [] : [{ cursorStart, cursorEnd: nextCursor, stream: "stdout", text }],
    nextCursor,
    truncatedBefore: processRun.outputTruncated && normalizedCursor < tailStart,
    outputTruncated: processRun.outputTruncated,
  };
}

function resolveTerminalStatus(input: {
  requestedExitReason: ShellProcessExitReason | null;
  result: ShellCommandResult | null;
  waitError: unknown;
}): Exclude<ShellProcessStatus, "starting" | "running" | "lost"> {
  if (input.requestedExitReason === "timeout") {
    return "timed_out";
  }
  if (
    input.requestedExitReason === "requested" ||
    input.requestedExitReason === "runtime_shutdown"
  ) {
    return "killed";
  }
  if (input.waitError != null || input.result == null || input.result.exitCode !== 0) {
    return "failed";
  }
  return "completed";
}

function processLimitError(scope: "global" | "owner", limit: number) {
  return toolRecoverableError(
    `Managed shell process limit reached (${scope}: ${limit}). Use the process tool to inspect and stop an existing process before starting another one.`,
    {
      code: "shell_process_limit_reached",
      scope,
      limit,
    },
  );
}

function managerClosingError() {
  return toolRecoverableError("Pokoclaw is shutting down and cannot start another process.", {
    code: "shell_process_manager_closing",
  });
}

function unknownProcessError(id: string) {
  return toolRecoverableError(
    "Shell process not found. Use process action=list to inspect available processRunIds.",
    {
      code: "shell_process_not_found",
      processRunId: id,
    },
  );
}

function renderCommandPreview(command: string): string {
  const normalized = command.replace(/\s+/gu, " ").trim();
  return normalized.length <= COMMAND_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, COMMAND_PREVIEW_CHARS - 1)}…`;
}

function renderErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= MAX_ERROR_TEXT_CHARS ? text : `${text.slice(0, MAX_ERROR_TEXT_CHARS - 1)}…`;
}

function parseTimestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toUtf8(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function waitForSettlementOrDeadline(
  settlement: Promise<unknown>,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout != null) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    settlement.then(finish, finish);
    if (signal?.aborted === true || waitMs <= 0) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });
    timeout = setTimeout(finish, waitMs);
  });
}

function createStartingShellProcess(ownerAgentId: string): StartingShellProcess {
  const abortController = new AbortController();
  let cancellationReason: ShellProcessStartupCancellationReason | null = null;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let finishCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    finishCompletion = resolve;
  });
  let finished = false;

  return {
    ownerAgentId,
    abortController,
    cancellation,
    get cancellationReason() {
      return cancellationReason;
    },
    cancel(reason) {
      if (cancellationReason != null) {
        return;
      }
      cancellationReason = reason;
      abortController.abort(reason);
      rejectCancellation(new Error(`Managed shell process startup cancelled: ${reason}`));
    },
    completion,
    finish() {
      if (finished) {
        return;
      }
      finished = true;
      finishCompletion();
    },
  };
}

function invokeStartHandle(
  startHandle: (signal: AbortSignal) => Promise<ShellCommandHandle>,
  signal: AbortSignal,
): Promise<ShellCommandHandle> {
  try {
    return startHandle(signal);
  } catch (error) {
    return Promise.reject(error);
  }
}

function scheduleLateHandleCleanup(startPromise: Promise<ShellCommandHandle>, id: string): void {
  void startPromise.then(
    (handle) => cleanupStartedHandle(handle, id),
    () => {},
  );
}

async function cleanupStartedHandle(handle: ShellCommandHandle, id: string): Promise<void> {
  void handle.wait().catch(() => {});
  try {
    await handle.terminate({ graceMs: DEFAULT_TERMINATION_GRACE_MS });
  } catch (error) {
    logger.warn("late managed shell process cleanup failed", {
      processRunId: id,
      error: renderErrorText(error),
    });
  }
}
