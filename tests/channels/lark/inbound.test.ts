import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { AgentSessionService } from "@/src/agent/session.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  buildLarkThreadSurfaceKey,
  createLarkCardActionHandler,
  createLarkInboundRuntime,
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

function makeRawMessage(messageType: string, content: unknown) {
  return {
    sender: {
      id: "ou_sender_raw",
      id_type: "open_id",
      sender_type: "user",
    },
    message_id: "om_msg_raw_1",
    chat_id: "oc_chat_1",
    chat_type: "p2p",
    msg_type: messageType,
    create_time: "1774569600000",
    body: {
      content: JSON.stringify(content),
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

  test("extracts image keys from image messages", () => {
    expect(
      normalizeLarkTextMessage(makeMessageEvent("image", { image_key: "img_v3_123" })),
    ).toMatchObject({
      text: "[图片 img_v3_123]",
      imageKeys: ["img_v3_123"],
    });
  });

  test("normalizes raw lark image payloads using msg_type and body.content", () => {
    expect(
      normalizeLarkTextMessage(makeRawMessage("image", { image_key: "img_v3_raw_123" })),
    ).toMatchObject({
      chatId: "oc_chat_1",
      messageId: "om_msg_raw_1",
      senderOpenId: "ou_sender_raw",
      senderType: "user",
      messageType: "image",
      text: "[图片 img_v3_raw_123]",
      imageKeys: ["img_v3_raw_123"],
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

  test("extracts image keys from post messages", () => {
    expect(
      normalizeLarkTextMessage(
        makeMessageEvent("post", {
          zh_cn: {
            content: [
              [
                { tag: "md", text: "Here are screenshots" },
                { tag: "img", image_key: "img_v3_post_1" },
                { tag: "img", image_key: "img_v3_post_2" },
              ],
            ],
          },
        }),
      ),
    ).toMatchObject({
      text: "Here are screenshots![image](img_v3_post_1)![image](img_v3_post_2)",
      imageKeys: ["img_v3_post_1", "img_v3_post_2"],
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

  test("downloads inbound image messages and forwards them in userPayload", async () => {
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
      const messageResourceGet = vi.fn(async () => ({
        headers: { "content-type": "image/jpeg" },
        getReadableStream: () => Readable.from(Buffer.from("fake-image")),
      }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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
        clients,
      });

      await handler(makeMessageEvent("image", { image_key: "img_v3_123" }));

      expect(messageResourceGet).toHaveBeenCalledOnce();
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_v3_123]",
        userPayload: {
          content: "[图片 img_v3_123]",
          images: [
            {
              type: "image",
              id: "img_v3_123",
              messageId: "om_msg_1",
              mimeType: "image/jpeg",
            },
          ],
        },
        runtimeImages: [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            data: Buffer.from("fake-image").toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("downloads inbound image messages from raw lark payloads and forwards runtimeImages", async () => {
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
      const messageResourceGet = vi.fn(async () => ({
        headers: { "content-type": "image/png" },
        getReadableStream: () => Readable.from(Buffer.from("raw-image")),
      }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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
        clients,
      });

      await handler(makeRawMessage("image", { image_key: "img_v3_raw_123" }));

      expect(messageResourceGet).toHaveBeenCalledOnce();
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_v3_raw_123]",
        userPayload: {
          content: "[图片 img_v3_raw_123]",
          images: [
            {
              type: "image",
              id: "img_v3_raw_123",
              messageId: "om_msg_raw_1",
              mimeType: "image/png",
            },
          ],
        },
        runtimeImages: [
          {
            type: "image",
            id: "img_v3_raw_123",
            messageId: "om_msg_raw_1",
            data: Buffer.from("raw-image").toString("base64"),
            mimeType: "image/png",
          },
        ],
        channelMessageId: "om_msg_raw_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("keeps only successfully fetched post images in payload metadata", async () => {
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
      const messageResourceGet = vi.fn(async (input: { path: { file_key: string } }) => {
        if (input.path.file_key === "img_v3_post_ok") {
          return {
            headers: { "content-type": "text/html; charset=utf-8" },
            getReadableStream: () => Readable.from(Buffer.from("post-image-ok")),
          };
        }
        throw new Error("download failed");
      });
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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
        clients,
      });

      await handler(
        makeMessageEvent("post", {
          zh_cn: {
            content: [
              [
                { tag: "md", text: "Two images" },
                { tag: "img", image_key: "img_v3_post_ok" },
                { tag: "img", image_key: "img_v3_post_fail" },
              ],
            ],
          },
        }),
      );

      expect(messageResourceGet).toHaveBeenCalledTimes(2);
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "Two images![image](img_v3_post_ok)![image](img_v3_post_fail)",
        userPayload: {
          content: "Two images![image](img_v3_post_ok)![image](img_v3_post_fail)",
          images: [
            {
              type: "image",
              id: "img_v3_post_ok",
              messageId: "om_msg_1",
              mimeType: "image/png",
            },
          ],
        },
        runtimeImages: [
          {
            type: "image",
            id: "img_v3_post_ok",
            messageId: "om_msg_1",
            data: Buffer.from("post-image-ok").toString("base64"),
            mimeType: "image/png",
          },
        ],
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("drops empty downloaded image resources from payload metadata", async () => {
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
      const messageResourceGet = vi.fn(async () => ({
        headers: { "content-type": "image/jpeg" },
        getReadableStream: () => Readable.from(Buffer.alloc(0)),
      }));
      const clients = {
        getOrCreate: vi.fn(() => ({
          sdk: {
            im: {
              messageResource: {
                get: messageResourceGet,
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
        clients,
      });

      await handler(makeMessageEvent("image", { image_key: "img_v3_empty" }));

      expect(messageResourceGet).toHaveBeenCalledOnce();
      expect(submitMessage).toHaveBeenCalledExactlyOnceWith({
        sessionId: "sess_chat_1",
        scenario: "chat",
        content: "[图片 img_v3_empty]",
        channelMessageId: "om_msg_1",
        createdAt: new Date("2026-03-27T00:00:00.000Z"),
      });
    });
  });

  test("replies with a failure card when runtime ingress rejects a lark message", async () => {
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

      const submitMessage = vi.fn(async () => {
        throw new Error(
          "Run hit the configured max turn limit (60) before producing a final response.",
        );
      });
      const create = vi.fn(async () => ({ data: { message_id: "om_fail_1" } }));
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
        clients,
      });

      await expect(handler(makeTextEvent("hello from lark"))).rejects.toThrow(
        "configured max turn limit (60)",
      );
      expect(create).toHaveBeenCalledOnce();
      const createCall = (create as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0] as { params?: unknown; data?: { content?: string } } | undefined;
      expect(createCall).toMatchObject({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: "oc_chat_1",
          msg_type: "interactive",
        },
      });
      expect(createCall?.data?.content ?? "").toContain("执行失败");
      expect(createCall?.data?.content ?? "").toContain("max turn limit (60)");
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
        sourceKind: "command",
        requestScope: "conversation",
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
        sourceKind: "command",
        requestScope: "session",
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
        sourceKind: "command",
        requestScope: "session",
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

  test("routes /status inside a task thread back to the stored thread anchor when parent_id is missing", async () => {
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

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const reply = vi.fn(async () => ({ data: { message_id: "om_task_status_thread_1" } }));
      const status = {
        getConversationStatus: vi.fn(() => ({
          conversationId: "conv_main",
          sessionId: "sess_task_1",
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
          message_id: "om_task_thread_status_1",
          chat_id: "oc_chat_1",
          chat_type: "p2p",
          thread_id: "omt_task_thread_1",
          message_type: "text",
          create_time: "1774569600000",
          content: JSON.stringify({ text: "/status" }),
        },
      });

      expect(submitMessage).not.toHaveBeenCalled();
      expect(status.getConversationStatus).toHaveBeenCalledExactlyOnceWith({
        conversationId: "conv_main",
        sessionId: "sess_task_1",
        scenario: "task",
      });
      expect(reply).toHaveBeenCalledOnce();
      expect(
        (reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
      ).toMatchObject({
        path: { message_id: "om_task_card_1" },
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

  test("routes /help to a markdown help card with slash command guidance", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const surfacesRepo = new ChannelSurfacesRepo(handle.storage.db);
      surfacesRepo.upsert({
        id: "surface_help_1",
        channelType: "lark",
        channelInstallationId: "default",
        conversationId: "conv_main",
        branchId: "branch_main",
        surfaceKey: buildLarkChatSurfaceKey("oc_chat_1"),
        surfaceObjectJson: JSON.stringify({ chat_id: "oc_chat_1" }),
      });

      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const create = vi.fn(async () => ({ data: { message_id: "om_help_1" } }));
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        clients: {
          getOrCreate: vi.fn(() => ({
            sdk: {
              im: {
                message: {
                  create,
                  reply: vi.fn(),
                },
              },
            },
          })) as unknown as (installationId: string) => LarkSdkClient,
        },
      });

      await handler(makeTextEvent("/help"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
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
      expect(content.header?.title?.content).toBe("Slash Commands");
      const markdown = (content.body?.elements ?? [])
        .filter((element) => element.tag === "markdown")
        .map((element) => element.content ?? "")
        .join("\n");
      expect(markdown).toBe(
        [
          "### Slash Commands",
          "- /help — Show this help message.",
          "- /status — Show the current conversation status, model, usage, and active runs.",
          "- /model — Open the model switch card for the current conversation.",
          "- /stop — Stop the current conversation or session.",
        ].join("\n"),
      );
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
      sourceKind: "button",
      requestScope: "run",
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

  test("forwards modelSwitch through lark inbound runtime so /model works end-to-end", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      type InboundDispatcher = {
        invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>;
      };
      const dispatchers: InboundDispatcher[] = [];
      const wsClose = vi.fn();
      const messageCreate = vi.fn(async () => ({}));
      const modelSwitch = {
        getOverview: vi.fn(() => ({
          models: [
            {
              index: 1,
              modelId: "gpt5",
              providerId: "main",
              upstreamModelId: "openai/gpt-5",
              supportsTools: true,
              supportsVision: false,
              supportsReasoning: true,
            },
          ],
          scenarios: [
            {
              scenario: "chat",
              currentModelId: "gpt5",
              configuredModelIds: ["gpt5"],
            },
          ],
        })),
      };
      const runtime = createLarkInboundRuntime({
        installations: [
          {
            installationId: "default",
            appId: "cli_123",
            appSecret: "secret_123",
            config: {
              enabled: true,
              appId: "cli_123",
              appSecret: "secret_123",
              connectionMode: "websocket",
            },
          },
        ],
        storage: handle.storage.db,
        ingress: {
          submitMessage: vi.fn(async () => ({ status: "started" as const })),
          submitApprovalDecision: vi.fn(() => false),
        },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        modelSwitch: modelSwitch as never,
        clients: {
          getOrCreate: () =>
            ({
              sdk: {
                im: {
                  message: {
                    create: messageCreate,
                    reply: vi.fn(async () => ({})),
                  },
                },
              },
            }) as unknown as LarkSdkClient,
        },
        wsClientFactory: () =>
          ({
            start: ({ eventDispatcher }: { eventDispatcher: InboundDispatcher }) => {
              dispatchers.push(eventDispatcher);
            },
            close: wsClose,
          }) as never,
      });

      runtime.start();
      const activeDispatcher = dispatchers.at(0);
      if (activeDispatcher == null) {
        throw new Error("expected lark inbound runtime to install an event dispatcher");
      }
      await activeDispatcher.invoke(
        {
          schema: "2.0",
          header: {
            event_type: "im.message.receive_v1",
          },
          event: makeTextEvent("/model"),
        },
        { needCheck: false },
      );

      expect(modelSwitch.getOverview).toHaveBeenCalledTimes(1);
      expect(messageCreate).toHaveBeenCalledTimes(1);

      await runtime.shutdown();
      expect(wsClose).toHaveBeenCalledOnce();
    });
  });

  test("routes /model to the model switch service and sends an interactive card", async () => {
    await withHandle(async (handle) => {
      seedFixture(handle);
      const submitMessage = vi.fn(async () => ({ status: "started" as const }));
      const messageCreate = vi.fn(async () => ({}));
      const modelSwitch = {
        getOverview: vi.fn(() => ({
          models: [
            {
              index: 1,
              modelId: "gpt5",
              providerId: "main",
              upstreamModelId: "openai/gpt-5",
              supportsTools: true,
              supportsVision: false,
              supportsReasoning: true,
            },
          ],
          scenarios: [
            {
              scenario: "chat",
              currentModelId: "gpt5",
              configuredModelIds: ["gpt5"],
            },
          ],
        })),
      };
      const handler = createLarkMessageReceiveHandler({
        installationId: "default",
        storage: handle.storage.db,
        ingress: { submitMessage, submitApprovalDecision: vi.fn(() => false) },
        control: new RuntimeControlService(new SessionRunAbortRegistry()),
        modelSwitch: modelSwitch as never,
        clients: {
          getOrCreate: () =>
            ({
              sdk: {
                im: {
                  message: {
                    create: messageCreate,
                    reply: vi.fn(async () => ({})),
                  },
                },
              },
            }) as unknown as LarkSdkClient,
        },
      });

      await handler(makeTextEvent("/model"));

      expect(submitMessage).not.toHaveBeenCalled();
      expect(modelSwitch.getOverview).toHaveBeenCalledTimes(1);
      expect(messageCreate).toHaveBeenCalledTimes(1);
      const firstCall = messageCreate.mock.calls.at(0) as
        | [
            {
              data?: {
                msg_type?: string;
                content?: string;
              };
            },
          ]
        | undefined;
      const payload = firstCall?.[0];
      expect(payload?.data?.msg_type).toBe("interactive");
      const content = JSON.parse(String(payload?.data?.content)) as {
        header?: { title?: { content?: string } };
      };
      expect(content.header?.title?.content).toBe("模型切换");
    });
  });

  test("returns an updated card when selecting a scenario from the model switch card", async () => {
    const modelSwitch = {
      getOverview: vi.fn(() => ({
        models: [
          {
            index: 1,
            modelId: "gpt5",
            providerId: "main",
            upstreamModelId: "openai/gpt-5",
            supportsTools: true,
            supportsVision: false,
            supportsReasoning: true,
          },
        ],
        scenarios: [
          {
            scenario: "chat",
            currentModelId: "gpt5",
            configuredModelIds: ["gpt5"],
          },
        ],
      })),
      switchScenarioModel: vi.fn(),
    };
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      modelSwitch: modelSwitch as never,
    });

    const result = await handler({
      action: {
        value: {
          action: "model_switch_select_scenario",
          scenario: "chat",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(modelSwitch.getOverview).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "模型切换",
            },
          },
        },
      },
    });
  });

  test("applies a model switch from card action and returns toast plus refreshed card", async () => {
    const modelSwitch = {
      getOverview: vi.fn(() => ({
        models: [
          {
            index: 1,
            modelId: "gpt5",
            providerId: "main",
            upstreamModelId: "openai/gpt-5",
            supportsTools: true,
            supportsVision: false,
            supportsReasoning: true,
          },
        ],
        scenarios: [
          {
            scenario: "chat",
            currentModelId: "gpt5",
            configuredModelIds: ["gpt5"],
          },
        ],
      })),
      switchScenarioModel: vi.fn(async () => ({
        scenario: "chat",
        previousModelId: "deepseek",
        nextModelId: "gpt5",
        configuredModelIds: ["gpt5", "deepseek"],
        reloaded: true,
        version: 2,
        warnings: [],
      })),
    };
    const handler = createLarkCardActionHandler({
      installationId: "default",
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
        submitApprovalDecision: vi.fn(() => false),
      },
      control: {} as RuntimeControlService,
      modelSwitch: modelSwitch as never,
    });

    const result = await handler({
      action: {
        value: {
          action: "model_switch_apply",
          scenario: "chat",
          modelId: "gpt5",
        },
      },
      operator: {
        open_id: "ou_sender",
      },
    });

    expect(modelSwitch.switchScenarioModel).toHaveBeenCalledExactlyOnceWith({
      scenario: "chat",
      modelId: "gpt5",
    });
    expect(result).toMatchObject({
      toast: {
        type: "success",
        content: "已切换 chat → gpt5",
      },
      card: {
        type: "raw",
        data: {
          header: {
            title: {
              content: "模型切换",
            },
          },
        },
      },
    });
  });
});
