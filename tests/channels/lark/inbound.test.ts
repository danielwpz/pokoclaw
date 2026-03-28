import { describe, expect, test, vi } from "vitest";

import {
  buildLarkChatSurfaceKey,
  createLarkCardActionHandler,
  createLarkMessageReceiveHandler,
  normalizeLarkTextMessage,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
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

function makeTextEvent(text: string) {
  return {
    sender: {
      sender_id: { open_id: "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: "om_msg_1",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      create_time: "1774569600000",
      content: JSON.stringify({ text }),
    },
  };
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
          content: JSON.stringify({ text: "为什么这里这样写？" }),
        },
      }),
    ).toMatchObject({
      messageId: "om_msg_quote",
      parentMessageId: "om_parent_1",
      threadId: null,
      text: "为什么这里这样写？",
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
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
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
        text: "被引用的原消息内容",
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
          content: JSON.stringify({ text: "请看这条引用消息" }),
        },
      });

      expect(quoteMessageFetcher).toHaveBeenCalledExactlyOnceWith({
        installationId: "default",
        messageId: "om_parent_1",
      });
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "用户引用了一条消息：\n被引用的原消息内容\n\n用户的新消息：请看这条引用消息",
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
          content: JSON.stringify({ text: "请继续" }),
        },
      });

      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "用户引用了一条消息，但系统未能读取原文。\n\n用户的新消息：请继续",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
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

  test("ignores non-text events without calling runtime ingress", async () => {
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

      expect(submitMessage).not.toHaveBeenCalled();
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
