import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentLoop, RunAgentLoopInput, RunAgentLoopResult } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { ContextClearService } from "@/src/context-clear/service.js";
import { ContextClearRepo } from "@/src/storage/repos/context-clear.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("context clear service", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("forks a handoff snapshot and atomically starts a fresh context before queued input", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChat(handle);
    const loop = createHandoffLoop("Resume from workspace/plan.md and finish the migration.");
    const service = new ContextClearService({ storage: handle.storage.db, loop });

    const clear = service.request("session_main", "lark:om_clear_1");
    const queuedInputId = service.enqueue({
      clearRunId: clear.id,
      sessionId: "session_main",
      scenario: "chat",
      content: "Also preserve the API compatibility constraint.",
      userPayload: {
        content: "Also preserve the API compatibility constraint.",
        attachments: [],
      },
      runtimeImages: [
        {
          type: "image",
          id: "image_1",
          messageId: "channel_image_1",
          mimeType: "image/png",
          data: "aW1hZ2U=",
        },
      ],
      channelMessageId: "om_queued",
      createdAt: new Date("2026-08-19T08:00:03.000Z"),
    });
    const duplicateInputId = service.enqueue({
      clearRunId: clear.id,
      sessionId: "session_main",
      scenario: "chat",
      content: "duplicate delivery must not be queued",
      channelMessageId: "om_queued",
    });

    const result = await service.execute(clear.id);

    expect(result).toMatchObject({
      status: "completed",
      clearRunId: clear.id,
      sessionId: "session_main",
      contextEpoch: 1,
    });
    expect(result.drainedInputs).toHaveLength(1);
    expect(duplicateInputId).toBe(queuedInputId);
    expect(result.drainedInputs[0]?.runtimeImages[0]?.data).toBe("aW1hZ2U=");
    expect(service.request("session_main", "lark:om_clear_1").id).toBe(clear.id);
    expect(loop.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: settledHandoffSessionId(handle, clear.id),
        scenario: "task",
      }),
    );

    const sessions = new SessionsRepo(handle.storage.db);
    expect(sessions.getById("session_main")).toMatchObject({
      compactCursor: 2,
      compactSummary: null,
      compactSummaryTokenTotal: null,
      compactSummaryUsageJson: null,
      contextEpoch: 1,
      compactionsSinceClear: 0,
      lastClearReminderCount: 0,
    });
    const context = new AgentSessionService(
      sessions,
      new MessagesRepo(handle.storage.db),
    ).getContext("session_main");
    expect(context.messages.map((message) => message.messageType)).toEqual([
      "context_clear_kickoff",
      "text",
    ]);
    expect(context.messages[0]?.visibility).toBe("hidden_system");
    expect(context.messages[0]?.payloadJson).toContain(
      "Resume from workspace/plan.md and finish the migration.",
    );
    expect(context.messages[0]?.payloadJson).toContain("Session ID: session_main");
    expect(context.messages[0]?.payloadJson).toContain(
      "Do not mistake unloaded history for unavailable history.",
    );
    expect(context.messages[0]?.payloadJson).toContain(
      "use query_system_db with this session ID before answering or acting",
    );
    expect(context.messages[1]?.channelMessageId).toBe("om_queued");

    const settled = new ContextClearRepo(handle.storage.db).getById(clear.id);
    expect(settled).toMatchObject({ status: "completed", sourceSeq: 2 });
    const handoffSession = sessions.getById(settled?.handoffSessionId ?? "missing");
    expect(handoffSession).toMatchObject({
      purpose: "context_handoff",
      status: "ended",
      forkedFromSessionId: "session_main",
      forkSourceSeq: 2,
    });
    const handoffMessages = new MessagesRepo(handle.storage.db).listBySession(
      handoffSession?.id ?? "missing",
    );
    const handoffRequest = handoffMessages.at(-1)?.payloadJson ?? "";
    expect(handoffRequest).toContain("internal continuity handoff");
    expect(handoffRequest).toContain("genuinely long-lived information");
    expect(handoffRequest).toContain("query_system_db");
    expect(handoffRequest).toContain("read the system-observe skill");
    expect(handoffRequest).toContain("bounded, text-only conversation-history recipe");
    expect(handoffRequest).toContain("The original session is session_main");
    expect(handoffRequest).toContain("clear boundary is source seq 2");
    expect(handoffRequest).toContain("submit_context_handoff exactly once");
  });

  test("preserves the old compact context and drains queued messages when handoff does not submit", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChat(handle);
    const service = new ContextClearService({
      storage: handle.storage.db,
      loop: createHandoffLoop(null),
    });
    const clear = service.request("session_main");
    service.enqueue({
      clearRunId: clear.id,
      sessionId: "session_main",
      scenario: "chat",
      content: "queued during failure",
      channelMessageId: "om_failure",
    });

    const result = await service.execute(clear.id);

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("without calling submit_context_handoff");
    expect(new SessionsRepo(handle.storage.db).getById("session_main")).toMatchObject({
      compactCursor: 1,
      compactSummary: "old compact summary",
      contextEpoch: 0,
      compactionsSinceClear: 7,
      lastClearReminderCount: 5,
    });
    const messages = new MessagesRepo(handle.storage.db).listBySession("session_main");
    expect(messages.map((message) => message.messageType)).toEqual(["text", "text", "text"]);
    expect(messages.at(-1)?.channelMessageId).toBe("om_failure");
    expect(new ContextClearRepo(handle.storage.db).getById(clear.id)?.status).toBe("failed");
  });

  test("restart recovery fails unfinished clears and restores durable queued input", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChat(handle);
    const service = new ContextClearService({
      storage: handle.storage.db,
      loop: createHandoffLoop("unused"),
    });
    const clear = service.request("session_main");
    service.enqueue({
      clearRunId: clear.id,
      sessionId: "session_main",
      scenario: "chat",
      content: "survive restart",
      channelMessageId: "om_restart",
    });

    const recovered = service.recoverAfterRestart();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: "failed", clearRunId: clear.id });
    expect(recovered[0]?.drainedInputs).toHaveLength(1);
    expect(new ContextClearRepo(handle.storage.db).getById(clear.id)?.errorText).toContain(
      "process restart",
    );
    expect(new MessagesRepo(handle.storage.db).listBySession("session_main").at(-1)).toMatchObject({
      channelMessageId: "om_restart",
    });
  });

  test("restart recovery resumes queued input after a completed clear until its run is acknowledged", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChat(handle);
    const service = new ContextClearService({
      storage: handle.storage.db,
      loop: createHandoffLoop("Continue with the queued request."),
    });
    const clear = service.request("session_main");
    service.enqueue({
      clearRunId: clear.id,
      sessionId: "session_main",
      scenario: "chat",
      content: "survive after successful clear",
      runtimeImages: [
        {
          type: "image",
          id: "restart_image",
          messageId: "om_restart_image",
          mimeType: "image/png",
          data: "cmVzdGFydA==",
        },
      ],
      channelMessageId: "om_completed_restart",
    });

    const completed = await service.execute(clear.id);
    const recovered = service.recoverAfterRestart();

    expect(completed.status).toBe("completed");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: "completed",
      clearRunId: clear.id,
      sessionId: "session_main",
    });
    expect(recovered[0]?.drainedInputs).toEqual(completed.drainedInputs);

    service.markQueuedInputsProcessed(clear.id);

    expect(service.recoverAfterRestart()).toEqual([]);
  });

  test("does not resume a completed queued-input run whose final response was already persisted", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChat(handle);
    const service = new ContextClearService({
      storage: handle.storage.db,
      loop: createHandoffLoop("Answer the queued request."),
    });
    const clear = service.request("session_main");
    service.enqueue({
      clearRunId: clear.id,
      sessionId: "session_main",
      scenario: "chat",
      content: "already answered before restart",
    });
    await service.execute(clear.id);
    const messages = new MessagesRepo(handle.storage.db);
    messages.append({
      id: "message_final_response",
      sessionId: "session_main",
      seq: messages.getNextSeq("session_main"),
      role: "assistant",
      payloadJson: JSON.stringify({ content: "done" }),
      stopReason: "stop",
    });

    expect(service.recoverAfterRestart()).toEqual([]);
    expect(
      handle.storage.sqlite
        .prepare(
          "SELECT count(*) AS count FROM context_clear_pending_inputs WHERE clear_run_id = ?",
        )
        .get(clear.id),
    ).toEqual({ count: 0 });
  });

  test("rolls back the handoff fork when recording the running clear fails", async () => {
    handle = await createTestDatabase(import.meta.url);
    seedMainChat(handle);
    const service = new ContextClearService({
      storage: handle.storage.db,
      loop: createHandoffLoop("unused"),
    });
    const clear = service.request("session_main");
    handle.storage.sqlite.exec(`
      CREATE TRIGGER reject_context_clear_running
      BEFORE UPDATE OF status ON context_clear_runs
      WHEN NEW.status = 'running'
      BEGIN
        SELECT RAISE(ABORT, 'forced markRunning failure');
      END;
    `);

    const result = await service.execute(clear.id);

    expect(result).toMatchObject({ status: "failed", clearRunId: clear.id });
    expect(
      handle.storage.sqlite
        .prepare("SELECT count(*) AS count FROM sessions WHERE purpose = 'context_handoff'")
        .get(),
    ).toEqual({ count: 0 });
  });
});

function settledHandoffSessionId(handle: TestDatabaseHandle, clearRunId: string): string {
  const handoffSessionId = new ContextClearRepo(handle.storage.db).getById(
    clearRunId,
  )?.handoffSessionId;
  if (handoffSessionId == null) {
    throw new Error(`Missing handoff session for clear ${clearRunId}`);
  }
  return handoffSessionId;
}

function seedMainChat(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('channel_1', 'lark', 'default', '2026-08-19T08:00:00.000Z', '2026-08-19T08:00:00.000Z');
    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conversation_main', 'channel_1', 'chat_main', 'dm', '2026-08-19T08:00:00.000Z', '2026-08-19T08:00:00.000Z');
    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_main', 'conversation_main', 'dm_main', 'main', '2026-08-19T08:00:00.000Z', '2026-08-19T08:00:00.000Z');
    INSERT INTO agents (id, conversation_id, kind, display_name, created_at)
    VALUES ('agent_main', 'conversation_main', 'main', 'Poko', '2026-08-19T08:00:00.000Z');
    INSERT INTO sessions (
      id, conversation_id, branch_id, owner_agent_id, purpose, status,
      compact_cursor, compact_summary, compact_summary_token_total,
      compact_summary_usage_json, compactions_since_clear, last_clear_reminder_count,
      created_at, updated_at
    ) VALUES (
      'session_main', 'conversation_main', 'branch_main', 'agent_main', 'chat', 'active',
      1, 'old compact summary', 20,
      '{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30}', 7, 5,
      '2026-08-19T08:00:00.000Z', '2026-08-19T08:00:00.000Z'
    );
  `);
  const messages = new MessagesRepo(handle.storage.db);
  messages.append({
    id: "message_old",
    sessionId: "session_main",
    seq: 1,
    role: "user",
    payloadJson: JSON.stringify({ content: "old raw history" }),
    createdAt: new Date("2026-08-19T08:00:01.000Z"),
  });
  messages.append({
    id: "message_recent",
    sessionId: "session_main",
    seq: 2,
    role: "user",
    payloadJson: JSON.stringify({ content: "current migration task" }),
    createdAt: new Date("2026-08-19T08:00:02.000Z"),
  });
}

function createHandoffLoop(kickoffMessage: string | null): AgentLoop {
  const run = vi.fn(async (input: RunAgentLoopInput): Promise<RunAgentLoopResult> => {
    let stopSignal: RunAgentLoopResult["stopSignal"] = null;
    if (kickoffMessage != null && input.afterToolResultHook != null) {
      const decision = await input.afterToolResultHook.afterToolResult({
        run: input,
        sessionPurpose: "context_handoff",
        ownerAgentId: "agent_main",
        agentKind: "main",
        runId: "handoff_run",
        turn: 1,
        toolCall: {
          id: "tool_call_1",
          name: "submit_context_handoff",
          args: { kickoffMessage },
        },
        result: {
          content: [{ type: "text", text: "Context handoff recorded." }],
          details: { contextHandoff: { kickoffMessage } },
        },
      });
      if (decision?.kind === "stop_run") {
        stopSignal = { reason: decision.reason, payload: decision.payload };
      }
    }
    return {
      runId: "handoff_run",
      sessionId: input.sessionId,
      scenario: input.scenario,
      modelId: "test-model",
      appendedMessageIds: [],
      toolExecutions: kickoffMessage == null ? 0 : 1,
      compaction: {
        shouldCompact: false,
        reason: null,
        effectiveWindow: 100_000,
        thresholdTokens: 90_000,
      },
      events: [],
      stopSignal,
    };
  });
  return { run } as unknown as AgentLoop;
}
