import type {
  AssistantMessage,
  Message as PiMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { Message } from "@/src/storage/schema/types.js";

export type AgentAssistantContentBlock =
  | {
      type: "text";
      text: string;
      textSignature?: string;
    }
  | {
      type: "thinking";
      thinking: string;
      thinkingSignature?: string;
      redacted?: boolean;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    };

export interface AgentAssistantPayload {
  content: AgentAssistantContentBlock[];
}

export type AgentToolResultContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "json";
      json: unknown;
    };

export interface AgentToolResultPayload {
  toolCallId: string;
  toolName: string;
  content: AgentToolResultContentBlock[];
  isError: boolean;
  details?: unknown;
}

export interface AgentUserPayload {
  content: string;
}

export function buildPiMessages(messages: Message[]): PiMessage[] {
  return messages.map((message) => buildPiMessage(message));
}

export function buildPiMessage(message: Message): PiMessage {
  switch (message.role) {
    case "user":
      return buildPiUserMessage(message);
    case "assistant":
      return buildPiAssistantMessage(message);
    case "tool":
      return buildPiToolResultMessage(message);
    default:
      throw new Error(`Unsupported stored message role: ${message.role}`);
  }
}

function buildPiUserMessage(message: Message): UserMessage {
  const payload = parsePayload<AgentUserPayload>(message.payloadJson, message.id);
  if (typeof payload.content !== "string") {
    throw new Error(`Stored user message ${message.id} is missing string payload.content`);
  }

  return {
    role: "user",
    content: payload.content,
    timestamp: parseMessageTimestamp(message),
  };
}

function buildPiAssistantMessage(message: Message): AssistantMessage {
  // Assistant rows must be reconstructable into pi-compatible transcript entries.
  // We persist the role-specific payload in JSON and keep the critical pi metadata
  // (provider/model/api/stopReason) in columns so history replay and debugging stay simple.
  const payload = parsePayload<AgentAssistantPayload>(message.payloadJson, message.id);
  if (!Array.isArray(payload.content)) {
    throw new Error(`Stored assistant message ${message.id} is missing payload.content array`);
  }

  if (!message.modelApi) {
    throw new Error(`Stored assistant message ${message.id} is missing modelApi`);
  }
  if (!message.provider) {
    throw new Error(`Stored assistant message ${message.id} is missing provider`);
  }
  if (!message.model) {
    throw new Error(`Stored assistant message ${message.id} is missing model`);
  }
  if (!message.stopReason) {
    throw new Error(`Stored assistant message ${message.id} is missing stopReason`);
  }

  return {
    role: "assistant",
    content: payload.content,
    api: message.modelApi,
    provider: message.provider,
    model: message.model,
    usage: parseUsage(message),
    stopReason: parseStopReason(message.stopReason, message.id),
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: parseMessageTimestamp(message),
  };
}

function buildPiToolResultMessage(message: Message): ToolResultMessage {
  // Tool results are replayed back into pi history, so we normalize our stored
  // payload into pi's ToolResultMessage instead of inventing a parallel format.
  const payload = parsePayload<AgentToolResultPayload>(message.payloadJson, message.id);
  if (typeof payload.toolCallId !== "string" || payload.toolCallId.length === 0) {
    throw new Error(`Stored tool result message ${message.id} is missing toolCallId`);
  }
  if (typeof payload.toolName !== "string" || payload.toolName.length === 0) {
    throw new Error(`Stored tool result message ${message.id} is missing toolName`);
  }
  if (!Array.isArray(payload.content)) {
    throw new Error(`Stored tool result message ${message.id} is missing payload.content array`);
  }
  if (typeof payload.isError !== "boolean") {
    throw new Error(`Stored tool result message ${message.id} is missing isError`);
  }

  return {
    role: "toolResult",
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    content: payload.content.map((block) => convertToolResultContentBlock(block)),
    ...(payload.details !== undefined ? { details: payload.details } : {}),
    isError: payload.isError,
    timestamp: parseMessageTimestamp(message),
  };
}

function convertToolResultContentBlock(block: AgentToolResultContentBlock) {
  if (block.type === "text") {
    return block;
  }

  return {
    type: "text" as const,
    text: JSON.stringify(block.json),
  };
}

function parsePayload<T>(payloadJson: string, messageId: string): T {
  try {
    return JSON.parse(payloadJson) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Stored message ${messageId} has invalid payloadJson: ${detail}`);
  }
}

function parseUsage(message: Message): Usage {
  if (!message.usageJson) {
    throw new Error(`Stored assistant message ${message.id} is missing usageJson`);
  }

  try {
    return JSON.parse(message.usageJson) as Usage;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Stored assistant message ${message.id} has invalid usageJson: ${detail}`);
  }
}

function parseMessageTimestamp(message: Message): number {
  const timestamp = Date.parse(message.createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Stored message ${message.id} has invalid createdAt timestamp`);
  }

  return timestamp;
}

function parseStopReason(stopReason: string, messageId: string): AssistantMessage["stopReason"] {
  switch (stopReason) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
      return stopReason;
    default:
      throw new Error(`Stored assistant message ${messageId} has unsupported stopReason`);
  }
}
