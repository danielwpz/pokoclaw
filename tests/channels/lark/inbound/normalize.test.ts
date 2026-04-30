import { describe, expect, test } from "vitest";
import { normalizeLarkTextMessage } from "@/src/channels/lark/inbound.js";
import { makeMessageEvent, makeRawMessage, makeTextEvent } from "./fixtures.js";

describe("lark inbound message handling / normalize", () => {
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

  test("normalizes merge forward messages into a fetchable notice", () => {
    const normalized = normalizeLarkTextMessage({
      schema: "2.0",
      event_type: "im.message.receive_v1",
      message: {
        chat_id: "oc_chat_1",
        chat_type: "group",
        content: "Merged and Forwarded Message",
        create_time: "1777545100937",
        message_id: "om_merge_forward_1",
        message_type: "merge_forward",
      },
      sender: {
        sender_id: { open_id: "ou_sender" },
        sender_type: "user",
      },
    });

    expect(normalized).toMatchObject({
      chatId: "oc_chat_1",
      messageId: "om_merge_forward_1",
      messageType: "merge_forward",
      text: expect.stringContaining("Lark message_id: om_merge_forward_1"),
    });
    expect("skipReason" in normalized).toBe(false);
    if (!("skipReason" in normalized)) {
      expect(normalized.text).toContain("merged forwarded chat-history message");
      expect(normalized.text).toContain("Do not assume the forwarded content is visible");
      expect(normalized.text).toContain("ask them to forward or paste the original messages");
      expect(normalized.text).not.toContain("Merged and Forwarded Message");
    }
  });
});
