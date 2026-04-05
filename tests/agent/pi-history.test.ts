import { describe, expect, test } from "vitest";
import { buildPiMessage, buildPiMessages } from "@/src/agent/llm/messages.js";
import type { Message } from "@/src/storage/schema/types.js";

function makeStoredMessage(overrides: Partial<Message>): Message {
  return {
    id: "msg_1",
    sessionId: "sess_1",
    seq: 1,
    role: "user",
    messageType: "text",
    visibility: "user_visible",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: "{}",
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: "2026-03-22T00:00:01.000Z",
    ...overrides,
  };
}

describe("pi history", () => {
  test("reconstructs user, assistant, and toolResult messages from stored rows", () => {
    const messages: Message[] = [
      makeStoredMessage({
        id: "msg_user",
        role: "user",
        payloadJson: JSON.stringify({ content: "hello" }),
      }),
      makeStoredMessage({
        id: "msg_assistant",
        seq: 2,
        role: "assistant",
        provider: "anthropic_main",
        model: "claude-sonnet-4-5",
        modelApi: "anthropic-messages",
        stopReason: "toolUse",
        payloadJson: JSON.stringify({
          content: [
            { type: "text", text: "Inspecting." },
            { type: "toolCall", id: "tool_1", name: "bash", arguments: { command: "ls" } },
          ],
        }),
        usageJson: JSON.stringify({
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 125,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.1,
            cacheWrite: 0,
            total: 3.1,
          },
        }),
      }),
      makeStoredMessage({
        id: "msg_tool",
        seq: 3,
        role: "tool",
        messageType: "tool_result",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({
          toolCallId: "tool_1",
          toolName: "bash",
          content: [{ type: "text", text: "README.md" }],
          isError: false,
          details: { exitCode: 0 },
        }),
      }),
    ];

    expect(buildPiMessages(messages)).toEqual([
      {
        role: "user",
        content: "hello",
        timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
      },
      {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic_main",
        model: "claude-sonnet-4-5",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Inspecting." },
          { type: "toolCall", id: "tool_1", name: "bash", arguments: { command: "ls" } },
        ],
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 125,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.1,
            cacheWrite: 0,
            total: 3.1,
          },
        },
        timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
      },
      {
        role: "toolResult",
        toolCallId: "tool_1",
        toolName: "bash",
        content: [{ type: "text", text: "README.md" }],
        isError: false,
        details: { exitCode: 0 },
        timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
      },
    ]);
  });

  test("serializes json tool result blocks into text for pi compatibility", () => {
    const message = makeStoredMessage({
      role: "tool",
      messageType: "tool_result",
      payloadJson: JSON.stringify({
        toolCallId: "tool_1",
        toolName: "read_file",
        content: [{ type: "json", json: { ok: true, items: [1, 2] } }],
        isError: false,
      }),
    });

    expect(buildPiMessage(message)).toEqual({
      role: "toolResult",
      toolCallId: "tool_1",
      toolName: "read_file",
      content: [{ type: "text", text: JSON.stringify({ ok: true, items: [1, 2] }) }],
      isError: false,
      timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
    });
  });

  test("reconstructs multimodal user messages from legacy inline image data too", () => {
    const message = makeStoredMessage({
      payloadJson: JSON.stringify({
        content: "请看这张图",
        images: [
          {
            type: "image",
            id: "img_v3_legacy",
            data: "ZmFrZS1pbWFnZQ==",
            mimeType: "image/png",
          },
        ],
      }),
    });

    expect(buildPiMessage(message)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "请看这张图" },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
      timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
    });
  });

  test("reconstructs multimodal user messages with attached runtime images", () => {
    const message = makeStoredMessage({
      payloadJson: JSON.stringify({
        content: "请看这张图",
        images: [{ type: "image", id: "img_v3_123", messageId: "om_msg_1", mimeType: "image/png" }],
      }),
    });

    expect(
      buildPiMessage(message, {
        resolveRuntimeImages: () => [
          {
            type: "image",
            id: "img_v3_123",
            messageId: "om_msg_1",
            data: "ZmFrZS1pbWFnZQ==",
            mimeType: "image/png",
          },
        ],
      }),
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "请看这张图" },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
      timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
    });
  });

  test("keeps only placeholder text when runtime image bytes are no longer available", () => {
    const message = makeStoredMessage({
      payloadJson: JSON.stringify({
        content: "[图片 img_v3_123]",
        images: [{ type: "image", id: "img_v3_123", messageId: "om_msg_1", mimeType: "image/png" }],
      }),
    });

    expect(buildPiMessage(message)).toEqual({
      role: "user",
      content: "[图片 img_v3_123]",
      timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
    });
  });

  test("falls back to an English note when the current model does not support vision", () => {
    const message = makeStoredMessage({
      payloadJson: JSON.stringify({
        content: "Please review this",
        images: [{ type: "image", id: "img_v3_123", messageId: "om_msg_1", mimeType: "image/png" }],
      }),
    });

    expect(buildPiMessage(message, { supportsVision: false })).toEqual({
      role: "user",
      content:
        "Please review this\n[Note: The user attached 1 image (image IDs: img_v3_123), but the current model is not configured for vision, so the image content is not available to you.]",
      timestamp: Date.parse("2026-03-22T00:00:01.000Z"),
    });
  });

  test("fails clearly when stored assistant metadata is incomplete", () => {
    const message = makeStoredMessage({
      role: "assistant",
      payloadJson: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      usageJson: JSON.stringify({
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    });

    expect(() => buildPiMessage(message)).toThrow("missing modelApi");
  });

  test("reconstructs assistant usage from token columns when usageJson is missing", () => {
    const message = makeStoredMessage({
      role: "assistant",
      provider: "anthropic_main",
      model: "claude-sonnet-4-5",
      modelApi: "anthropic-messages",
      stopReason: "stop",
      payloadJson: JSON.stringify({ content: [{ type: "text", text: "hi" }] }),
      tokenInput: 11,
      tokenOutput: 7,
      tokenCacheRead: 3,
      tokenCacheWrite: 0,
      tokenTotal: 21,
      usageJson: null,
    });

    expect(buildPiMessage(message)).toMatchObject({
      role: "assistant",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 21,
      },
    });
  });
});
