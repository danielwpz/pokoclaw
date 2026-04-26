import { describe, expect, test, vi } from "vitest";
import { AgentSessionService } from "@/src/agent/session.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import {
  buildLarkChatSurfaceKey,
  createLarkMessageReceiveHandler,
  createLarkQuoteMessageFetcher,
} from "@/src/channels/lark/inbound.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { seedFixture, withHandle } from "./fixtures.js";

describe("lark inbound quote handling", () => {
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
});
