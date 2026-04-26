import { describe, expect, test, vi } from "vitest";
import { AgentSessionService } from "@/src/agent/session.js";
import {
  buildLarkThreadSurfaceKey,
  createLarkMessageReceiveHandler,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { seedFixture, withHandle } from "./fixtures.js";

describe("lark inbound thread routing", () => {
  test("creates an ordinary thread branch from the latest main chat context", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      handle.storage.sqlite.exec(`
        UPDATE sessions
        SET compact_cursor = 1,
            compact_summary = 'main chat summary',
            compact_summary_token_total = 12,
            compact_summary_usage_json = '{"input":8,"output":4,"cacheRead":0,"cacheWrite":0,"totalTokens":12}'
        WHERE id = 'sess_chat_1';
      `);
      messagesRepo.append({
        id: "msg_main_1",
        sessionId: "sess_chat_1",
        seq: 1,
        role: "user",
        payloadJson: '{"content":"older"}',
        createdAt: new Date("2026-03-27T00:00:00.500Z"),
      });
      messagesRepo.append({
        id: "msg_main_2",
        sessionId: "sess_chat_1",
        seq: 2,
        role: "assistant",
        provider: "anthropic_main",
        model: "claude-sonnet-4-5",
        modelApi: "anthropic-messages",
        stopReason: "stop",
        payloadJson: '{"content":[{"type":"text","text":"Latest context from the main chat"}]}',
        createdAt: new Date("2026-03-27T00:00:01.000Z"),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        quoteMessageFetcher: vi.fn(async () => ({
          messageType: "text",
          text: "A much older message",
        })),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_thread_msg_1",
          parent_id: "om_parent_old",
          thread_id: "omt_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Let's discuss this point separately here." }),
        },
      });

      expect(submitMessage).toHaveBeenCalledOnce();
      const firstCall = (submitMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { sessionId: string; scenario: string; content: string } | undefined;
      expect(firstCall?.scenario).toBe("chat");
      expect(firstCall?.content).toBe("Let's discuss this point separately here.");
      expect(firstCall?.sessionId).not.toBe("sess_chat_1");

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      const threadSurface = surfacesRepo.getBySurfaceKey({
        channelType: "lark",
        channelInstallationId: "default",
        surfaceKey: buildLarkThreadSurfaceKey("oc_chat_1", "omt_thread_1"),
      });
      expect(threadSurface).not.toBeNull();

      const forkedSessionId = firstCall?.sessionId ?? "";
      const forkedSession = new SessionsRepo(handle.storage.db).getById(forkedSessionId);
      expect(forkedSession).toMatchObject({
        purpose: "chat",
        forkedFromSessionId: "sess_chat_1",
        compactSummary: "main chat summary",
      });

      const context = new AgentSessionService(
        new SessionsRepo(handle.storage.db),
        messagesRepo,
      ).getContext(forkedSessionId);
      expect(context.messages.at(-1)).toMatchObject({
        role: "user",
        messageType: "thread_kickoff",
        visibility: "hidden_system",
      });
      expect(context.messages.at(-1)?.payloadJson).toContain("The user opened a separate thread.");
      expect(context.messages.at(-1)?.payloadJson).toContain(
        "The quoted message is below. Continue the discussion around it.",
      );
      expect(context.messages.at(-1)?.payloadJson).toContain("A much older message");
      expect(context.messages.map((message) => message.payloadJson)).toContain(
        '{"content":[{"type":"text","text":"Latest context from the main chat"}]}',
      );
    });
  });

  test("routes task thread messages into the existing task session and records the thread anchor", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_1',
          'running', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z'
        );
      `);
      new LarkObjectBindingsRepo(handle.storage.db).upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_1",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_1",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "steered" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_msg_1",
          parent_id: "om_task_card_1",
          thread_id: "omt_task_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Please prioritize this error." }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_task_1",
        scenario: "task",
        content: "Please prioritize this error.",
        channelMessageId: "om_task_thread_msg_1",
        channelParentMessageId: "om_task_card_1",
        channelThreadId: "omt_task_thread_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });

      expect(
        new LarkObjectBindingsRepo(handle.storage.db).getByThreadRootMessageId({
          channelInstallationId: "default",
          threadRootMessageId: "omt_task_thread_1",
        }),
      ).toMatchObject({
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
      });
    });
  });

  test("routes later task thread messages by stored thread binding without re-reading the task card", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_1',
          'running', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z'
        );
      `);
      new LarkObjectBindingsRepo(handle.storage.db).upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_1",
        threadRootMessageId: "omt_task_thread_1",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_1",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "steered" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_msg_2",
          parent_id: "om_user_reply_1",
          thread_id: "omt_task_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Continue, but prioritize fixing the previous error." }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_task_1",
        scenario: "task",
        content: "Continue, but prioritize fixing the previous error.",
        channelMessageId: "om_task_thread_msg_2",
        channelParentMessageId: "om_user_reply_1",
        channelThreadId: "omt_task_thread_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("routes task thread replies to a transcript child message via the child binding", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_1',
          'running', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z'
        );
      `);
      const bindingsRepo = new LarkObjectBindingsRepo(handle.storage.db);
      bindingsRepo.upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_status_1",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_1",
          taskRunId: "task_1",
          taskRunType: "cron",
          role: "task_status",
        }),
      });
      bindingsRepo.upsert({
        id: "binding_task_thread_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "run_task_1:seg:1",
        larkMessageId: "om_task_thread_card_1",
        larkCardId: "card_task_thread_1",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_1",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "steered" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_msg_child_1",
          parent_id: "om_task_thread_card_1",
          thread_id: "omt_task_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Use the stack trace above and fix the failing step." }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_task_1",
        scenario: "task",
        content: "Use the stack trace above and fix the failing step.",
        channelMessageId: "om_task_thread_msg_child_1",
        channelParentMessageId: "om_task_thread_card_1",
        channelThreadId: "omt_task_thread_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });

      expect(
        bindingsRepo.getByThreadRootMessageId({
          channelInstallationId: "default",
          threadRootMessageId: "omt_task_thread_1",
        }),
      ).toMatchObject({
        internalObjectId: "run_task_1:seg:1",
      });
    });
  });

  test("creates a follow-up task-thread run when the bound task session has already finished", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at, ended_at)
        VALUES (
          'sess_task_missing', 'conv_main', 'branch_main', 'agent_main', 'task', 'completed',
          '2026-03-27T00:00:03.000Z', '2026-03-27T00:05:00.000Z', '2026-03-27T00:05:00.000Z'
        );

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at, finished_at, result_summary
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_missing',
          'completed', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z',
          '2026-03-27T00:05:00.000Z', 'previous result'
        );
      `);
      new LarkObjectBindingsRepo(handle.storage.db).upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_1",
        threadRootMessageId: "omt_task_thread_missing",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_missing",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const taskThreads = {
        createFollowupExecution: vi.fn(() => ({
          taskRunId: "task_followup_1",
          sessionId: "sess_task_followup_1",
          conversationId: "conv_main",
          branchId: "branch_main",
        })),
        completeTaskExecution: vi.fn(),
        blockTaskExecution: vi.fn(),
        failTaskExecution: vi.fn(),
      };
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        taskThreads,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_msg_missing",
          parent_id: "om_user_reply_missing",
          thread_id: "omt_task_thread_missing",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Can we keep discussing this in the thread?" }),
        },
      });

      expect(taskThreads.createFollowupExecution).toHaveBeenCalledExactlyOnceWith({
        rootTaskRunId: "task_1",
        initiatorThreadId: expect.any(String),
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
      expect(submitMessage).toHaveBeenCalledOnce();
      const firstCall = (submitMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { sessionId: string; scenario: string; content: string } | undefined;
      expect(firstCall).toMatchObject({
        sessionId: "sess_task_followup_1",
        scenario: "task",
        content: "Can we keep discussing this in the thread?",
      });
    });
  });

  test("routes task-thread follow-up by root run instead of the shared workstream", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at, ended_at)
        VALUES (
          'sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'completed',
          '2026-03-27T00:00:03.000Z', '2026-03-27T00:05:00.000Z', '2026-03-27T00:05:00.000Z'
        );

        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at, ended_at)
        VALUES (
          'sess_task_2', 'conv_main', 'branch_main', 'agent_main', 'task', 'completed',
          '2026-03-27T00:10:03.000Z', '2026-03-27T00:15:00.000Z', '2026-03-27T00:15:00.000Z'
        );

        INSERT INTO task_workstreams (id, owner_agent_id, conversation_id, branch_id, created_at, updated_at)
        VALUES (
          'ws_1', 'agent_main', 'conv_main', 'branch_main',
          '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, workstream_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'ws_1', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, workstream_id, thread_root_run_id,
          execution_session_id, status, priority, attempt, description, input_json, started_at, finished_at
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'ws_1', 'task_1',
          'sess_task_1', 'completed', 0, 1, 'Older task thread', '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:05:00.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, workstream_id, thread_root_run_id,
          execution_session_id, status, priority, attempt, description, input_json, started_at, finished_at
        ) VALUES (
          'task_2', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'ws_1', 'task_2',
          'sess_task_2', 'completed', 0, 1, 'Newer task thread', '{}', '2026-03-27T00:10:03.000Z', '2026-03-27T00:15:00.000Z'
        );

        INSERT INTO channel_threads (
          id, channel_type, channel_installation_id, home_conversation_id, external_chat_id, external_thread_id,
          subject_kind, root_task_run_id, opened_from_message_id, created_at, updated_at
        ) VALUES (
          'thread_1', 'lark', 'default', 'conv_main', 'oc_chat_1', 'omt_task_thread_1',
          'task', 'task_1', 'om_task_card_1', '2026-03-27T00:00:03.000Z', '2026-03-27T00:05:00.000Z'
        );
      `);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const taskThreads = {
        createFollowupExecution: vi.fn(() => ({
          taskRunId: "task_followup_1",
          sessionId: "sess_task_followup_1",
          conversationId: "conv_main",
          branchId: "branch_main",
        })),
        completeTaskExecution: vi.fn(),
        blockTaskExecution: vi.fn(),
        failTaskExecution: vi.fn(),
      };
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        taskThreads,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_msg_rooted",
          parent_id: "om_user_reply_rooted",
          thread_id: "omt_task_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Continue only this older run thread." }),
        },
      });

      expect(taskThreads.createFollowupExecution).toHaveBeenCalledExactlyOnceWith({
        rootTaskRunId: "task_1",
        initiatorThreadId: "thread_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("settles a task-thread follow-up run when finish_task completes it", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at, ended_at)
        VALUES (
          'sess_task_missing', 'conv_main', 'branch_main', 'agent_main', 'task', 'completed',
          '2026-03-27T00:00:03.000Z', '2026-03-27T00:05:00.000Z', '2026-03-27T00:05:00.000Z'
        );

        INSERT INTO cron_jobs (
          id, owner_agent_id, target_conversation_id, target_branch_id, schedule_kind, schedule_value,
          payload_json, created_at, updated_at
        ) VALUES (
          'cron_1', 'agent_main', 'conv_main', 'branch_main', 'cron', '0 * * * *',
          '{}', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z'
        );

        INSERT INTO task_runs (
          id, run_type, owner_agent_id, conversation_id, branch_id, cron_job_id, execution_session_id,
          status, priority, attempt, description, input_json, started_at, finished_at, result_summary
        ) VALUES (
          'task_1', 'cron', 'agent_main', 'conv_main', 'branch_main', 'cron_1', 'sess_task_missing',
          'completed', 0, 1, 'Existing task thread', '{}', '2026-03-27T00:00:03.000Z',
          '2026-03-27T00:05:00.000Z', 'previous result'
        );
      `);
      new LarkObjectBindingsRepo(handle.storage.db).upsert({
        id: "binding_task_card",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        internalObjectKind: "run_card",
        internalObjectId: "task:task_1",
        larkMessageId: "om_task_card_1",
        larkCardId: "card_task_1",
        threadRootMessageId: "omt_task_thread_missing",
        metadataJson: JSON.stringify({
          sessionId: "sess_task_missing",
          taskRunId: "task_1",
          taskRunType: "cron",
        }),
      });

      const submitMessage = vi.fn(async () => ({
        status: "started" as const,
        run: {
          stopSignal: {
            reason: "task_completion",
            payload: {
              taskCompletion: {
                status: "completed",
                summary: "short summary",
                finalMessage: "Thread follow-up finished",
              },
            },
          },
        },
      }));
      const taskThreads = {
        createFollowupExecution: vi.fn(() => ({
          taskRunId: "task_followup_1",
          sessionId: "sess_task_followup_1",
          conversationId: "conv_main",
          branchId: "branch_main",
        })),
        completeTaskExecution: vi.fn(),
        blockTaskExecution: vi.fn(),
        failTaskExecution: vi.fn(),
      };
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        taskThreads,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_msg_finish",
          parent_id: "om_user_reply_missing",
          thread_id: "omt_task_thread_missing",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Please finish this follow-up." }),
        },
      });

      const firstCall = (submitMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { afterToolResultHook?: unknown } | undefined;
      expect(firstCall?.afterToolResultHook).toBeTruthy();
      expect(taskThreads.completeTaskExecution).toHaveBeenCalledExactlyOnceWith({
        taskRunId: "task_followup_1",
        resultSummary: "Thread follow-up finished",
        finishedAt: new Date("2026-03-27T00:00:00.000Z"),
      });
      expect(taskThreads.blockTaskExecution).not.toHaveBeenCalled();
      expect(taskThreads.failTaskExecution).not.toHaveBeenCalled();
    });
  });
});
