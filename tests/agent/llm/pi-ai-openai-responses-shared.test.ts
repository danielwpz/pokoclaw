import { describe, expect, test } from "vitest";
import { buildPiMessages } from "@/src/agent/llm/messages.js";
import { convertResponsesMessages } from "@/src/agent/llm/pi-ai-openai-responses-shared.js";
import {
  APPROVAL_DENIED_USER_INTERVENTION_CODE,
  TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE,
} from "@/src/shared/tool-result-codes.js";
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

describe("pi ai openai responses shared", () => {
  test("preserves explicit synthetic interruption tool results instead of auto-filling missing outputs", () => {
    const messages: Message[] = [
      makeStoredMessage({
        id: "msg_user",
        payloadJson: JSON.stringify({ content: "run the whole plan" }),
      }),
      makeStoredMessage({
        id: "msg_assistant",
        seq: 2,
        role: "assistant",
        provider: "test-provider",
        model: "test-model",
        modelApi: "openai-responses",
        stopReason: "toolUse",
        usageJson: JSON.stringify({
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
        }),
        payloadJson: JSON.stringify({
          content: [
            { type: "toolCall", id: "tool_1", name: "step", arguments: { step: 1 } },
            { type: "toolCall", id: "tool_2", name: "needs_approval", arguments: {} },
            { type: "toolCall", id: "tool_3", name: "step", arguments: { step: 3 } },
          ],
        }),
      }),
      makeStoredMessage({
        id: "msg_tool_1",
        seq: 3,
        role: "tool",
        messageType: "tool_result",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({
          toolCallId: "tool_1",
          toolName: "step",
          content: [{ type: "text", text: "step 1 done" }],
          isError: false,
        }),
      }),
      makeStoredMessage({
        id: "msg_tool_2",
        seq: 4,
        role: "tool",
        messageType: "tool_result",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({
          toolCallId: "tool_2",
          toolName: "needs_approval",
          content: [
            {
              type: "text",
              text: "Automatically denied because the user sent a new message to redirect the run.",
            },
          ],
          isError: true,
          details: { code: APPROVAL_DENIED_USER_INTERVENTION_CODE },
        }),
      }),
      makeStoredMessage({
        id: "msg_tool_3",
        seq: 5,
        role: "tool",
        messageType: "tool_result",
        visibility: "hidden_system",
        payloadJson: JSON.stringify({
          toolCallId: "tool_3",
          toolName: "step",
          content: [
            {
              type: "text",
              text: "Skipped because the user sent a new message and redirected the run before this tool call started.",
            },
          ],
          isError: true,
          details: { code: TOOL_BATCH_ABORTED_USER_INTERVENTION_CODE },
        }),
      }),
      makeStoredMessage({
        id: "msg_user_2",
        seq: 6,
        payloadJson: JSON.stringify({ content: "Actually stop and summarize." }),
      }),
    ];

    const responseInput = convertResponsesMessages(
      {
        id: "test-provider/test-model",
        provider: "test-provider",
        api: "openai-responses",
        input: ["text"],
        reasoning: false,
      } as never,
      {
        systemPrompt: null,
        messages: buildPiMessages(messages),
      } as never,
      new Set<string>(),
      { includeSystemPrompt: false },
    ) as Array<{ type: string; call_id?: string; output?: unknown }>;

    const functionCallOutputs = responseInput.filter(
      (entry) => entry.type === "function_call_output",
    );
    expect(functionCallOutputs).toHaveLength(3);
    expect(functionCallOutputs.map((entry) => entry.call_id)).toEqual([
      "tool_1",
      "tool_2",
      "tool_3",
    ]);
    expect(functionCallOutputs.map((entry) => String(entry.output))).not.toContain(
      "No result provided",
    );
    expect(functionCallOutputs[1]?.output).toBe(
      "Automatically denied because the user sent a new message to redirect the run.",
    );
    expect(functionCallOutputs[2]?.output).toBe(
      "Skipped because the user sent a new message and redirected the run before this tool call started.",
    );
  });
});
