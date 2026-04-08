/**
 * Generic submit-loop executor for Meditation calls.
 *
 * The model is forced to finish via submit tool calls. Plain text-only turns are
 * reminded and retried within a small bounded turn budget.
 */
import { randomUUID } from "node:crypto";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { PiBridgeRunTurnResult } from "@/src/agent/llm/pi-bridge.js";
import type { SecurityConfig } from "@/src/config/schema.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import type { Message } from "@/src/storage/schema/types.js";
import { buildToolFailureContent, normalizeToolFailure } from "@/src/tools/core/errors.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import type { ToolDefinition, ToolResult } from "@/src/tools/core/types.js";

const DEFAULT_MAX_SUBMIT_TURNS = 3;
const DEFAULT_REMINDER_TEXT =
  "You must call the submit tool to finish this task. Do not reply with plain text only.";

export class MeditationSubmitLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeditationSubmitLoopError";
  }
}

export interface MeditationTurnBridge {
  completeTurn(input: {
    model: ResolvedModel;
    systemPrompt?: string;
    compactSummary: string | null;
    messages: Message[];
    tools: ToolRegistry;
    signal: AbortSignal;
  }): Promise<PiBridgeRunTurnResult>;
}

export interface RunMeditationSubmitLoopInput<TSubmission> {
  bridge: MeditationTurnBridge;
  model: ResolvedModel;
  prompt: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  getSubmission: () => TSubmission | null;
  storage: StorageDb;
  securityConfig: SecurityConfig;
  maxTurns?: number;
  reminderText?: string;
  now?: () => Date;
}

export interface MeditationSubmitLoopResult<TSubmission> {
  submission: TSubmission;
  messages: Message[];
  turns: PiBridgeRunTurnResult[];
}

export async function runMeditationSubmitLoop<TSubmission>(
  input: RunMeditationSubmitLoopInput<TSubmission>,
): Promise<MeditationSubmitLoopResult<TSubmission>> {
  if (!input.model.supportsTools) {
    throw new MeditationSubmitLoopError(
      `Meditation model "${input.model.id}" does not support tools, but submit tool is required.`,
    );
  }

  const tools = new ToolRegistry(input.tools);
  const now = input.now ?? (() => new Date());
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_SUBMIT_TURNS;
  const reminderText = input.reminderText ?? DEFAULT_REMINDER_TEXT;
  const sessionId = `meditation:${randomUUID()}`;
  const conversationId = sessionId;
  const signal = new AbortController().signal;
  const messages: Message[] = [buildUserMessage({ seq: 1, content: input.prompt, now: now() })];
  const turns: PiBridgeRunTurnResult[] = [];
  let nextSeq = 2;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const result = await input.bridge.completeTurn({
      model: input.model,
      ...(input.systemPrompt == null ? {} : { systemPrompt: input.systemPrompt }),
      compactSummary: null,
      messages,
      tools,
      signal,
    });
    turns.push(result);

    const assistantMessage = buildAssistantMessage({
      seq: nextSeq,
      result,
      now: now(),
      sessionId,
    });
    messages.push(assistantMessage);
    nextSeq += 1;

    const toolCalls = result.content.filter((block) => block.type === "toolCall");
    for (const toolCall of toolCalls) {
      try {
        const toolResult = await tools.execute(
          toolCall.name,
          {
            sessionId,
            conversationId,
            securityConfig: input.securityConfig,
            storage: input.storage,
            toolCallId: toolCall.id,
          },
          toolCall.arguments,
        );
        messages.push(
          buildToolResultMessage({
            seq: nextSeq,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result: toolResult,
            isError: false,
            now: now(),
            sessionId,
          }),
        );
        nextSeq += 1;
      } catch (error) {
        const failure = normalizeToolFailure(error);
        messages.push(
          buildToolResultMessage({
            seq: nextSeq,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result: {
              content: buildToolFailureContent(failure),
              ...(failure.details === undefined ? {} : { details: failure.details }),
            },
            isError: true,
            now: now(),
            sessionId,
          }),
        );
        nextSeq += 1;

        if (!failure.shouldReturnToLlm) {
          throw failure;
        }
      }

      const submission = input.getSubmission();
      if (submission != null) {
        return {
          submission,
          messages,
          turns,
        };
      }
    }

    messages.push(
      buildUserMessage({
        seq: nextSeq,
        content: reminderText,
        now: now(),
      }),
    );
    nextSeq += 1;
  }

  throw new MeditationSubmitLoopError(
    `Meditation submit loop exhausted ${maxTurns} turns without a valid submit.`,
  );
}

function buildUserMessage(input: {
  seq: number;
  content: string;
  now: Date;
  sessionId?: string;
}): Message {
  return {
    id: randomUUID(),
    sessionId: input.sessionId ?? "meditation",
    seq: input.seq,
    role: "user",
    messageType: "text",
    visibility: "hidden_system",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({
      content: input.content,
    }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: input.now.toISOString(),
  };
}

function buildAssistantMessage(input: {
  seq: number;
  result: PiBridgeRunTurnResult;
  now: Date;
  sessionId: string;
}): Message {
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    seq: input.seq,
    role: "assistant",
    messageType: "text",
    visibility: "hidden_system",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: input.result.provider,
    model: input.result.model,
    modelApi: input.result.modelApi,
    stopReason: input.result.stopReason,
    errorMessage: input.result.errorMessage ?? null,
    payloadJson: JSON.stringify({
      content: input.result.content,
    }),
    tokenInput: input.result.usage.input,
    tokenOutput: input.result.usage.output,
    tokenCacheRead: input.result.usage.cacheRead,
    tokenCacheWrite: input.result.usage.cacheWrite,
    tokenTotal: input.result.usage.totalTokens ?? null,
    usageJson: JSON.stringify(input.result.usage),
    createdAt: input.now.toISOString(),
  };
}

function buildToolResultMessage(input: {
  seq: number;
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  isError: boolean;
  now: Date;
  sessionId: string;
}): Message {
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    seq: input.seq,
    role: "tool",
    messageType: "tool_result",
    visibility: "hidden_system",
    channelMessageId: null,
    channelParentMessageId: null,
    channelThreadId: null,
    provider: null,
    model: null,
    modelApi: null,
    stopReason: null,
    errorMessage: null,
    payloadJson: JSON.stringify({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      content: input.result.content,
      isError: input.isError,
      ...(input.result.details === undefined ? {} : { details: input.result.details }),
    }),
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    tokenTotal: null,
    usageJson: null,
    createdAt: input.now.toISOString(),
  };
}
