import { describe, expect, test, vi } from "vitest";
import { AgentSessionService } from "@/src/agent/session.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  buildLarkThreadSurfaceKey,
  createLarkCardActionHandler,
  createLarkMessageReceiveHandler,
  createLarkQuoteMessageFetcher,
  normalizeLarkTextMessage,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import type { RuntimeStatusService } from "@/src/runtime/status.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { LarkObjectBindingsRepo } from "@/src/storage/repos/lark-object-bindings.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

async function withHandle(fn: (handle: TestDatabaseHandle) => Promise<void>): Promise<void> {
  const handle = await createTestDatabase(import.meta.url);
  try {
    await fn(handle);
  } finally {
    await destroyTestDatabase(handle);
  }
}

function seedFixture(handle: TestDatabaseHandle): void {
  handle.storage.sqlite.exec(`
    INSERT INTO channel_instances (id, provider, account_key, created_at, updated_at)
    VALUES ('ci_lark_default', 'lark', 'default', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversations (id, channel_instance_id, external_chat_id, kind, created_at, updated_at)
    VALUES ('conv_main', 'ci_lark_default', 'oc_chat_1', 'dm', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, created_at, updated_at)
    VALUES ('branch_main', 'conv_main', 'dm_main', 'main', '2026-03-27T00:00:00.000Z', '2026-03-27T00:00:00.000Z');

    INSERT INTO agents (id, conversation_id, main_agent_id, kind, created_at)
    VALUES ('agent_main', 'conv_main', NULL, 'main', '2026-03-27T00:00:00.000Z');

    INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
    VALUES ('sess_chat_1', 'conv_main', 'branch_main', 'agent_main', 'chat', 'active', '2026-03-27T00:00:01.000Z', '2026-03-27T00:00:02.000Z');
  `);
}

function makeMessageEvent(messageType: string, content: unknown) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: "om_msg_1",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: messageType,
      create_time: "1774569600000",
      content: JSON.stringify(content),
    },
  };
}

function makeTextEvent(text: string) {
  return makeMessageEvent("text", { text });
}

describe("lark inbound message handling", () => {
  test("normalizes a text event into plain text facts", () => {
    expect(normalizeLarkTextMessage(makeTextEvent(" hello "))).toMatchObject({
      chatId: "oc_chat_1",
      messageId: "om_msg_1",
      parentMessageId: null,
      threadId: null,
      senderOpenId: "ou_sender",
      senderType: "user",
      text: "hello",
    });
  });

  test("recognizes quote replies by parent_id without thread_id", () => {
    expect(
      normalizeLarkTextMessage({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_msg_quote",
          parent_id: "om_parent_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Why is this written this way?" }),
        },
      }),
    ).toMatchObject({
      messageId: "om_msg_quote",
      parentMessageId: "om_parent_1",
      threadId: null,
      text: "Why is this written this way?",
    });
  });

  test("normalizes a post event into markdown text", () => {
    expect(
      normalizeLarkTextMessage(
        makeMessageEvent("post", {
          zh_cn: {
            content: [[{ tag: "md", text: "- First item\n- Second item" }]],
          },
        }),
      ),
    ).toMatchObject({
      chatId: "oc_chat_1",
      messageId: "om_msg_1",
      text: "- First item\n- Second item",
    });
  });

  test("preserves raw markdown blocks from post content", () => {
    expect(
      normalizeLarkTextMessage(
        makeMessageEvent("post", {
          zh_cn: {
            title: "Release Notes",
            content: [[{ tag: "md", text: "## Heading\n- [Docs](https://example.com)\n`code`" }]],
          },
        }),
      ),
    ).toMatchObject({
      text: "**Release Notes**\n\n## Heading\n- [Docs](https://example.com)\n`code`",
    });
  });

  test("routes a text message through surface binding into runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello from lark"));

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "hello from lark",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("routes a post message through surface binding into runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(
        makeMessageEvent("post", {
          zh_cn: {
            content: [[{ tag: "md", text: "- First item\n- Second item" }]],
          },
        }),
      );

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "- First item\n- Second item",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("hydrates interactive inbound messages through message.get raw card content", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        quoteMessageFetcher: vi.fn(async () => ({
          messageType: "interactive",
          text: "- First item\n- Second item",
        })),
      });

      await handler(
        makeMessageEvent("interactive", {
          card_id: "card_xxx",
        }),
      );

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "- First item\n- Second item",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

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
        scenario: "cron",
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
        scenario: "cron",
        content: "Continue, but prioritize fixing the previous error.",
        channelMessageId: "om_task_thread_msg_2",
        channelParentMessageId: "om_user_reply_1",
        channelThreadId: "omt_task_thread_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("falls back to an ordinary thread when a stored task thread binding points to a missing task session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
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

      expect(submitMessage).toHaveBeenCalledOnce();
      const firstCall = (submitMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { sessionId: string; scenario: string; content: string } | undefined;
      expect(firstCall?.scenario).toBe("chat");
      expect(firstCall?.sessionId).not.toBe("sess_task_missing");
      expect(firstCall?.content).toBe("Can we keep discussing this in the thread?");

      const forkedSession = new SessionsRepo(handle.storage.db).getById(firstCall?.sessionId ?? "");
      expect(forkedSession).toMatchObject({
        purpose: "chat",
        forkedFromSessionId: "sess_chat_1",
      });
    });
  });

  test("expands quote replies by fetching the referenced message text", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const quoteMessageFetcher = vi.fn(async () => ({
        messageType: "text",
        text: "Original quoted message content",
      }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        quoteMessageFetcher,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_msg_quote_1",
          parent_id: "om_parent_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Please look at this quoted message." }),
        },
      });

      expect(quoteMessageFetcher).toHaveBeenCalledExactlyOnceWith({
        installationId: "default",
        messageId: "om_parent_1",
      });
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content:
          "The user quoted a message:\nOriginal quoted message content\n\nThe user's new message: Please look at this quoted message.",
        channelMessageId: "om_msg_quote_1",
        channelParentMessageId: "om_parent_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("falls back gracefully when quoted message lookup fails", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const quoteMessageFetcher = vi.fn(async () => null);
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        quoteMessageFetcher,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_msg_quote_2",
          parent_id: "om_parent_2",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "Please continue." }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content:
          "The user quoted an earlier message, but the quoted text could not be retrieved.\n\nTell the user you cannot see the quoted message and ask them to send it again.\n\nThe user's new message: Please continue.",
        channelMessageId: "om_msg_quote_2",
        channelParentMessageId: "om_parent_2",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("asks the user to resend the quoted message when an ordinary thread cannot load it", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const messagesRepo = new MessagesRepo(handle.storage.db);
      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        quoteMessageFetcher: vi.fn(async () => null),
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_thread_msg_2",
          parent_id: "om_parent_old_2",
          thread_id: "omt_thread_2",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "can you check this quote" }),
        },
      });

      const firstCall = (submitMessage as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { sessionId: string } | undefined;
      const forkedSessionId = firstCall?.sessionId ?? "";
      const context = new AgentSessionService(
        new SessionsRepo(handle.storage.db),
        messagesRepo,
      ).getContext(forkedSessionId);
      expect(context.messages.at(-1)?.payloadJson).toContain(
        "Tell the user you cannot see the quoted message and ask them to send it again.",
      );
      expect(context.messages.at(-1)?.payloadJson).toContain(
        "<quoted_message_unavailable>true</quoted_message_unavailable>",
      );
    });
  });

  test("parses interactive quoted messages through raw card content fetch", async () => {
    const request = vi.fn(async () => ({
      data: {
        items: [
          {
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                json_card: JSON.stringify({
                  schema: "2.0",
                  header: {
                    title: {
                      tag: "plain_text",
                      content: "Current Status",
                    },
                  },
                  body: {
                    elements: [
                      {
                        tag: "markdown",
                        content: "Please upgrade to the latest client to view this content.",
                      },
                    ],
                  },
                }),
              }),
            },
          },
        ],
      },
    }));
    const clients = {
      getOrCreate: vi.fn(() => ({
        sdk: {
          request,
        },
      })),
    } as unknown as {
      getOrCreate(installationId: string): LarkSdkClient;
    };

    const fetcher = createLarkQuoteMessageFetcher({
      installationId: "default",
      clients,
    });

    const quoted = await fetcher({
      installationId: "default",
      messageId: "om_parent_interactive",
    });

    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: "GET",
      url: "/open-apis/im/v1/messages/om_parent_interactive",
      params: {
        user_id_type: "open_id",
        card_msg_content_type: "raw_card_content",
      },
    });
    expect(quoted).toEqual({
      messageType: "interactive",
      text: "Current Status\nPlease upgrade to the latest client to view this content.",
    });
  });

  test("falls back to sdk message.get when raw request is unavailable", async () => {
    const get = vi.fn(async () => ({
      data: {
        items: [
          {
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                title: "Legacy Card",
                elements: [[{ tag: "text", text: "Placeholder content" }]],
              }),
            },
          },
        ],
      },
    }));
    const clients = {
      getOrCreate: vi.fn(() => ({
        sdk: {
          im: {
            message: {
              get,
            },
          },
        },
      })),
    } as unknown as {
      getOrCreate(installationId: string): LarkSdkClient;
    };

    const fetcher = createLarkQuoteMessageFetcher({
      installationId: "default",
      clients,
    });

    const quoted = await fetcher({
      installationId: "default",
      messageId: "om_parent_legacy",
    });

    expect(get).toHaveBeenCalledExactlyOnceWith({
      path: { message_id: "om_parent_legacy" },
      params: { user_id_type: "open_id" },
    });
    expect(quoted).toEqual({
      messageType: "interactive",
      text: "Legacy Card\nPlaceholder content",
    });
  });

  test("keeps long raw card content instead of truncating after a few nodes", async () => {
    const bodyLines = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}`);
    const request = vi.fn(async () => ({
      data: {
        items: [
          {
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                json_card: JSON.stringify({
                  schema: "2.0",
                  header: {
                    title: {
                      tag: "plain_text",
                      content: "Long Card",
                    },
                  },
                  body: {
                    elements: bodyLines.map((line) => ({
                      tag: "markdown",
                      content: line,
                    })),
                  },
                }),
              }),
            },
          },
        ],
      },
    }));
    const clients = {
      getOrCreate: vi.fn(() => ({
        sdk: {
          request,
        },
      })),
    } as unknown as {
      getOrCreate(installationId: string): LarkSdkClient;
    };

    const fetcher = createLarkQuoteMessageFetcher({
      installationId: "default",
      clients,
    });

    const quoted = await fetcher({
      installationId: "default",
      messageId: "om_parent_long_card",
    });

    expect(quoted).toEqual({
      messageType: "interactive",
      text: `Long Card\n${bodyLines.join(" ")}`,
    });
  });

  test("marks quoted card content when fallback truncation limits are hit", async () => {
    const bodyLines = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}`);
    const request = vi.fn(async () => ({
      data: {
        items: [
          {
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                json_card: JSON.stringify({
                  schema: "2.0",
                  header: {
                    title: {
                      tag: "plain_text",
                      content: "Overlong Card",
                    },
                  },
                  body: {
                    elements: bodyLines.map((line) => ({
                      tag: "markdown",
                      content: line,
                    })),
                  },
                }),
              }),
            },
          },
        ],
      },
    }));
    const clients = {
      getOrCreate: vi.fn(() => ({
        sdk: {
          request,
        },
      })),
    } as unknown as {
      getOrCreate(installationId: string): LarkSdkClient;
    };

    const fetcher = createLarkQuoteMessageFetcher({
      installationId: "default",
      clients,
    });

    const quoted = await fetcher({
      installationId: "default",
      messageId: "om_parent_truncated_card",
    });

    expect(quoted).toEqual({
      messageType: "interactive",
      text: expect.stringContaining("[卡片内容过长，引用文本已截断]"),
    });
    if (quoted == null) {
      throw new Error("Expected quoted message");
    }
    expect(quoted.text).toContain("Overlong Card");
    expect(quoted.text).toContain("Paragraph 48");
    expect(quoted.text).not.toContain("Paragraph 49");
  });

  test("backfills a surface from legacy conversation mapping before routing", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello again"));

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "hello again",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      expect(
        surfacesRepo.getBySurfaceKey({
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        }),
      ).not.toBeNull();
    });
  });

  test("pairs an installation on the first inbound message when nothing exists yet", async () => {
    await withHandle(async (handle) => {
      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
      });

      await handler(makeTextEvent("hello first pair"));

      expect(submitMessage).toHaveBeenCalledOnce();
      const firstCall = (submitMessage.mock.calls as unknown[][]).at(0);
      expect(firstCall).toBeDefined();
      expect(firstCall?.[0]).toMatchObject({
        scenario: "chat",
        content: "hello first pair",
      });

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      const surface = surfacesRepo.getBySurfaceKey({
        channelType: "lark",
        channelInstallationId: "default",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
      });
      expect(surface).not.toBeNull();

      const rows = handle.storage.sqlite
        .prepare("SELECT provider, account_key FROM channel_instances")
        .all() as Array<{ provider: string; account_key: string }>;
      expect(rows).toEqual([{ provider: "lark", account_key: "default" }]);
    });
  });

  test("ignores a new chat when the installation is already paired elsewhere", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
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
          message_id: "om_msg_unknown",
          chat_id: "oc_chat_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello unknown chat" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();

      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      expect(
        surfacesRepo.getBySurfaceKey({
          channelType: "lark",
          channelInstallationId: "default",
          surfaceKey: buildLarkChatSurfaceKey("oc_chat_2"),
        }),
      ).toBeNull();
    });
  });

  test("routes image placeholders through runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
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
          message_id: "om_msg_2",
          chat_id: "oc_chat_1",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_1]",
        channelMessageId: "om_msg_2",
      });
    });
  });

  test("routes /stop to control service instead of runtime ingress", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopConversation: vi.fn(() => ({
          acceptedCount: 1,
          conversationId: "conv_main",
          runIds: ["run_1"],
          sessionIds: ["sess_chat_1"],
        })),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control,
      });

      await handler(makeTextEvent("/stop"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopConversation).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        actor: "lark:default:ou_sender",
        reasonText: "stop requested from lark command",
      });
    });
  });

  test("routes /stop inside an ordinary thread to the thread session only", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, external_branch_id, parent_branch_id, created_at, updated_at)
        VALUES ('branch_thread_1', 'conv_main', 'dm_thread', 'thread:omt_thread_1', 'omt_thread_1', 'branch_main', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:03.000Z');

        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_thread_1', 'conv_main', 'branch_thread_1', 'agent_main', 'chat', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');
      `);
      new ChannelSurfacesRepo(handle.storage.db).upsert({
        id: "surface_thread_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_thread_1",
        surfaceKey: buildLarkThreadSurfaceKey("oc_chat_1", "omt_thread_1"),
        surfaceObjectJson: JSON.stringify({
          chat_id: "oc_chat_1",
          thread_id: "omt_thread_1",
          reply_to_message_id: "om_parent_1",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopSession: vi.fn(() => ({
          accepted: true,
          sessionId: "sess_thread_1",
          runIds: ["run_thread_1"],
          conversationId: "conv_main",
        })),
        stopConversation: vi.fn(),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_thread_stop_1",
          parent_id: "om_parent_1",
          thread_id: "omt_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/stop" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_thread_1",
        actor: "lark:default:ou_sender",
        reasonText: "stop requested from lark command",
      });
      expect(control.stopConversation).not.toHaveBeenCalled();
    });
  });

  test("routes /stop inside a task thread to the source task session", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_task_1', 'conv_main', 'branch_main', 'agent_main', 'task', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');
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

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const control = {
        stopSession: vi.fn(() => ({
          accepted: true,
          sessionId: "sess_task_1",
          runIds: ["run_task_1"],
          conversationId: "conv_main",
        })),
        stopConversation: vi.fn(),
      } as unknown as RuntimeControlService;
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_task_thread_stop_1",
          parent_id: "om_user_reply_1",
          thread_id: "omt_task_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/stop" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(control.stopSession).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_task_1",
        actor: "lark:default:ou_sender",
        reasonText: "stop requested from lark command",
      });
      expect(control.stopConversation).not.toHaveBeenCalled();
    });
  });

  test("routes /status inside an ordinary thread back into the same thread", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      handle.storage.sqlite.exec(`
        INSERT INTO conversation_branches (id, conversation_id, kind, branch_key, external_branch_id, parent_branch_id, created_at, updated_at)
        VALUES ('branch_thread_1', 'conv_main', 'dm_thread', 'thread:omt_thread_1', 'omt_thread_1', 'branch_main', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:03.000Z');

        INSERT INTO sessions (id, conversation_id, branch_id, owner_agent_id, purpose, status, created_at, updated_at)
        VALUES ('sess_thread_1', 'conv_main', 'branch_thread_1', 'agent_main', 'chat', 'active', '2026-03-27T00:00:03.000Z', '2026-03-27T00:00:04.000Z');
      `);
      new ChannelSurfacesRepo(handle.storage.db).upsert({
        id: "surface_thread_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_thread_1",
        surfaceKey: buildLarkThreadSurfaceKey("oc_chat_1", "omt_thread_1"),
        surfaceObjectJson: JSON.stringify({
          chat_id: "oc_chat_1",
          thread_id: "omt_thread_1",
          reply_to_message_id: "om_parent_1",
        }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const reply = vi.fn(async () => ({ data: { message_id: "om_status_thread_1" } }));
      const status = {
        getConversationStatus: vi.fn(() => ({
          conversationId: "conv_main",
          sessionId: "sess_thread_1",
          model: {
            configuredModelId: "openrouter-gpt5.4",
            providerId: "openrouter",
            upstreamModelId: "openai/gpt-5.4",
            modelApi: "openai-responses",
            supportsReasoning: true,
            source: "scenario_default" as const,
          },
          sessionUsage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          latestTurnUsage: null,
          latestTurnErrorMessage: null,
          activeRuns: [],
          pendingApprovals: [],
        })),
      } satisfies Pick<RuntimeStatusService, "getConversationStatus">;
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              message: {
                create: vi.fn(),
                reply,
              },
            },
          },
        })),
      } as unknown as { getOrCreate(installationId: string): LarkSdkClient };

      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        status: status as unknown as RuntimeStatusService,
        clients,
      });

      await handler({
        sender: {
          sender_id: { open_id: "ou_sender" },
          sender_type: "user",
        },
        message: {
          message_id: "om_thread_status_1",
          parent_id: "om_parent_1",
          thread_id: "omt_thread_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/status" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(status.getConversationStatus).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        sessionId: "sess_thread_1",
        scenario: "chat",
      });
      expect(reply).toHaveBeenCalledOnce();
      expect(
        (reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
      ).toMatchObject({
        path: { message_id: "om_parent_1" },
        data: {
          msg_type: "interactive",
          reply_in_thread: true,
        },
      });
    });
  });

  test("routes /status to the status service and sends a direct lark text reply", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const create = vi.fn(async () => ({ data: { message_id: "om_status_1" } }));
      const status = {
        getConversationStatus: vi.fn(() => ({
          conversationId: "conv_main",
          sessionId: "sess_chat_1",
          model: {
            configuredModelId: "openrouter-gpt5.4",
            providerId: "openrouter",
            upstreamModelId: "openai/gpt-5.4",
            modelApi: "openai-responses",
            supportsReasoning: true,
            source: "scenario_default" as const,
          },
          sessionUsage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.003,
            },
          },
          latestTurnUsage: null,
          latestTurnErrorMessage: null,
          activeRuns: [],
          pendingApprovals: [],
        })),
      } satisfies Pick<RuntimeStatusService, "getConversationStatus">;
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              message: {
                create,
              },
            },
          },
        })),
      } as unknown as { getOrCreate(installationId: string): LarkSdkClient };

      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        status: status as unknown as RuntimeStatusService,
        clients,
      });

      await handler(makeTextEvent("/status"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(status.getConversationStatus).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        sessionId: "sess_chat_1",
        scenario: "chat",
      });
      expect(create).toHaveBeenCalledOnce();
      const firstCall = create.mock.calls[0] as [Record<string, unknown>] | undefined;
      expect(firstCall?.[0]).toMatchObject({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat_1",
          msg_type: "interactive",
        },
      });
      const content = JSON.parse(
        String((firstCall?.[0] as { data?: { content?: string } } | undefined)?.data?.content),
      ) as {
        header?: { title?: { content?: string } };
        body?: { elements?: Array<{ tag?: string; content?: string }> };
      };
      expect(content.header?.title?.content).toBe("当前状态");
      const markdown = (content.body?.elements ?? [])
        .filter((element) => element.tag === "markdown")
        .map((element) => element.content ?? "")
        .join("\n");
      expect(markdown).toContain("openrouter-gpt5.4");
      expect(markdown).toContain("**版本**");
    });
  });
});

describe("lark card actions", () => {
  test("ignores unsupported card actions", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "unsupported_action",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("routes stop button callbacks to control service", async () => {
    const control = {
      stopRun: vi.fn(() => ({
        accepted: true,
        runId: "run_123",
        sessionId: "sess_123",
        conversationId: "conv_123",
      })),
    } as unknown as RuntimeControlService;

    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control,
    });

    const result = await handler({
      action: {
        value: {
          action: "stop_run",
          runId: "run_123",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(control.stopRun).toHaveBeenCalledExactlyOnceWith({
      runId: "run_123",
      actor: "lark:default:ou_sender",
      reasonText: "stop requested from lark card action",
    });
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "正在停止...",
      },
    });
  });

  test("returns an error toast when approval callbacks are missing approvalId", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          grantTtl: "one_day",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: {
        type: "error",
        content: "无法识别授权请求",
      },
    });
  });

  test("routes approve subagent creation callbacks to orchestration handler", async () => {
    const approve = vi.fn(async () => ({
      outcome: "created" as const,
      request: {} as never,
      externalChatId: "chat_sub_1",
      shareLink: "https://example.com/subagent-1",
    }));
    const deny = vi.fn();
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve,
        deny,
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_subagent_creation",
          requestId: "req_sub_1",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(approve).toHaveBeenCalledExactlyOnceWith("req_sub_1");
    expect(deny).not.toHaveBeenCalled();
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "SubAgent 已创建",
      },
    });
  });

  test("routes deny subagent creation callbacks to orchestration handler", async () => {
    const approve = vi.fn(async () => ({
      outcome: "created" as const,
      request: {} as never,
      externalChatId: "chat_sub_1",
      shareLink: "https://example.com/subagent-1",
    }));
    const deny = vi.fn(() => ({
      outcome: "denied" as const,
      request: {} as never,
      externalChatId: null,
      shareLink: null,
    }));
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve,
        deny,
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "deny_subagent_creation",
          requestId: "req_sub_2",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(approve).not.toHaveBeenCalled();
    expect(deny).toHaveBeenCalledExactlyOnceWith("req_sub_2");
    expect(result).toEqual({
      toast: {
        type: "info",
        content: "已取消创建",
      },
    });
  });

  test("treats duplicate approve subagent creation callbacks as info instead of failure", async () => {
    const approve = vi.fn(async () => ({
      outcome: "already_created" as const,
      request: {} as never,
      externalChatId: "chat_sub_1",
      shareLink: null,
    }));
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve,
        deny: vi.fn(),
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_subagent_creation",
          requestId: "req_sub_dup",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(result).toEqual({
      toast: {
        type: "info",
        content: "SubAgent 已创建",
      },
    });
  });

  test("treats duplicate deny subagent creation callbacks as info instead of failure", async () => {
    const deny = vi.fn(() => ({
      outcome: "already_denied" as const,
      request: {} as never,
      externalChatId: null,
      shareLink: null,
    }));
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      subagentRequests: {
        approve: vi.fn(async () => ({
          outcome: "created" as const,
          request: {} as never,
          externalChatId: "chat_sub_1",
          shareLink: null,
        })),
        deny,
      },
    });

    const result = await handler({
      action: {
        value: {
          action: "deny_subagent_creation",
          requestId: "req_sub_dup",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(result).toEqual({
      toast: {
        type: "info",
        content: "该请求已取消",
      },
    });
  });

  test("routes one-day approval callbacks to runtime ingress", async () => {
    const submitApprovalDecision = vi.fn(
      (_input: {
        approvalId: number;
        decision: "approve" | "deny";
        actor: string;
        rawInput?: string | null;
        grantedBy?: "user" | "main_agent";
        expiresAt?: Date | null;
      }) => true,
    );
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const before = Date.now();
    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          approvalId: 123,
          grantTtl: "one_day",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });
    const after = Date.now();

    expect(submitApprovalDecision).toHaveBeenCalledTimes(1);
    const call = submitApprovalDecision.mock.calls[0];
    expect(call).toBeDefined();
    if (call == null) {
      throw new Error("Expected approval decision call");
    }
    const input = call[0];
    expect(input).toMatchObject({
      approvalId: 123,
      decision: "approve",
      actor: "lark:default:ou_sender",
      rawInput: "approve_1d",
      grantedBy: "user",
    });
    expect(input.expiresAt).toBeInstanceOf(Date);
    expect(input.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(input.expiresAt?.getTime()).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "已允许 1天",
      },
    });
  });

  test("routes permanent approval callbacks to runtime ingress", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          approvalId: 456,
          grantTtl: "permanent",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 456,
      decision: "approve",
      actor: "lark:default:ou_sender",
      rawInput: "approve_permanent",
      grantedBy: "user",
      expiresAt: null,
    });
    expect(result).toEqual({
      toast: {
        type: "success",
        content: "已允许 永久",
      },
    });
  });

  test("routes deny approval callbacks to runtime ingress", async () => {
    const submitApprovalDecision = vi.fn(() => true);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "deny_permission",
          approvalId: 789,
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 789,
      decision: "deny",
      actor: "lark:default:ou_sender",
      rawInput: "deny",
      grantedBy: "user",
    });
    expect(result).toEqual({
      toast: {
        type: "error",
        content: "已拒绝",
      },
    });
  });

  test("returns an info toast when the approval request is no longer pending", async () => {
    const submitApprovalDecision = vi.fn(() => false);
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision,
      },
      control: {} as RuntimeControlService,
    });

    const result = await handler({
      action: {
        value: {
          action: "approve_permission",
          approvalId: 123,
          grantTtl: "permanent",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(submitApprovalDecision).toHaveBeenCalledExactlyOnceWith({
      approvalId: 123,
      decision: "approve",
      actor: "lark:default:ou_sender",
      rawInput: "approve_permanent",
      grantedBy: "user",
      expiresAt: null,
    });
    expect(result).toEqual({
      toast: {
        type: "info",
        content: "该授权请求已结束或无法处理",
      },
    });
  });
});
