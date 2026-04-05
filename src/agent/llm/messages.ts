/**
 * Message conversion layer between storage/runtime and pi-ai.
 *
 * Reconstructs model input messages from persisted transcript rows and maps
 * pi-ai assistant outputs back into local assistant/tool payload structures.
 */
import type {
  AssistantMessage,
  Message as PiMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "@/src/shared/logger.js";
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

const logger = createSubsystemLogger("llm-messages");

export interface AgentUserImagePayload {
  type: "image";
  id: string;
  messageId: string;
  mimeType: string;
}

export interface AgentUserRuntimeImagePayload extends AgentUserImagePayload {
  data: string;
}

export interface AgentUserPayload {
  content: string;
  images?: AgentUserImagePayload[];
}

export function normalizeAgentUserImageMessageId(imageId: string, messageId: unknown): string {
  return typeof messageId === "string" && messageId.length > 0 ? messageId : imageId;
}

export interface BuildPiMessageOptions {
  supportsVision?: boolean;
  resolveRuntimeImages?: (
    message: Message,
    images: AgentUserImagePayload[],
  ) => AgentUserRuntimeImagePayload[];
}

export function buildPiMessages(messages: Message[], options?: BuildPiMessageOptions): PiMessage[] {
  return messages.map((message) => buildPiMessage(message, options));
}

export function buildPiMessage(message: Message, options?: BuildPiMessageOptions): PiMessage {
  switch (message.role) {
    case "user":
      return buildPiUserMessage(message, options);
    case "assistant":
      return buildPiAssistantMessage(message);
    case "tool":
      return buildPiToolResultMessage(message);
    default:
      throw new Error(`Unsupported stored message role: ${message.role}`);
  }
}

function buildPiUserMessage(message: Message, options?: BuildPiMessageOptions): UserMessage {
  const payload = parsePayload<AgentUserPayload>(message.payloadJson, message.id);
  if (typeof payload.content !== "string") {
    throw new Error(`Stored user message ${message.id} is missing string payload.content`);
  }

  const parsedImages = parseUserImages(payload.images);
  const supportsVision = options?.supportsVision ?? true;
  const runtimeImages =
    options?.resolveRuntimeImages?.(message, parsedImages.images) ??
    parsedImages.inlineRuntimeImages;

  logger.debug("building pi user message", {
    storageMessageId: message.id,
    persistedImageCount: parsedImages.images.length,
    persistedImageIds: parsedImages.images.map((image) => image.id),
    inlineRuntimeImageCount: parsedImages.inlineRuntimeImages.length,
    resolvedRuntimeImageCount: runtimeImages.length,
    resolvedRuntimeImages: runtimeImages.map((image) => ({
      id: image.id,
      messageId: image.messageId,
      mimeType: image.mimeType,
      byteLength: Buffer.from(image.data, "base64").length,
    })),
    supportsVision,
  });

  return {
    role: "user",
    content: buildPiUserContent({
      content: payload.content,
      images: parsedImages.images,
      runtimeImages,
      supportsVision,
    }),
    timestamp: parseMessageTimestamp(message),
  };
}

function parseUserImages(images: unknown): {
  images: AgentUserImagePayload[];
  inlineRuntimeImages: AgentUserRuntimeImagePayload[];
} {
  if (!Array.isArray(images)) {
    return { images: [], inlineRuntimeImages: [] };
  }

  const parsedImages: AgentUserImagePayload[] = [];
  const inlineRuntimeImages: AgentUserRuntimeImagePayload[] = [];
  for (const image of images) {
    if (image?.type !== "image" || typeof image.id !== "string" || image.id.length === 0) {
      continue;
    }
    const messageId = normalizeAgentUserImageMessageId(image.id, image.messageId);
    if (typeof image.mimeType !== "string" || image.mimeType.length === 0) {
      continue;
    }
    parsedImages.push({
      type: "image",
      id: image.id,
      messageId,
      mimeType: image.mimeType,
    });
    if (typeof image.data === "string" && image.data.length > 0) {
      inlineRuntimeImages.push({
        type: "image",
        id: image.id,
        messageId,
        data: image.data,
        mimeType: image.mimeType,
      });
    }
  }

  return {
    images: parsedImages,
    inlineRuntimeImages,
  };
}

function buildPiUserContent(input: {
  content: string;
  images: AgentUserImagePayload[];
  runtimeImages: AgentUserRuntimeImagePayload[];
  supportsVision: boolean;
}): UserMessage["content"] {
  if (input.images.length === 0) {
    logger.debug("building pi user content without images", {
      supportsVision: input.supportsVision,
    });
    return input.content;
  }

  if (input.supportsVision && input.runtimeImages.length > 0) {
    logger.info("building pi user content with vision image blocks", {
      supportsVision: input.supportsVision,
      persistedImageCount: input.images.length,
      runtimeImageCount: input.runtimeImages.length,
      imageIds: input.images.map((image) => image.id),
    });
    return [
      { type: "text", text: input.content },
      ...input.runtimeImages.map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ];
  }

  if (!input.supportsVision) {
    logger.debug("building pi user content with unsupported-vision notice", {
      supportsVision: input.supportsVision,
      persistedImageCount: input.images.length,
      runtimeImageCount: input.runtimeImages.length,
      imageIds: input.images.map((image) => image.id),
    });
    return appendUnsupportedVisionNotice(input.content, input.images);
  }

  logger.debug("building pi user content with image metadata only", {
    supportsVision: input.supportsVision,
    persistedImageCount: input.images.length,
    runtimeImageCount: input.runtimeImages.length,
    imageIds: input.images.map((image) => image.id),
  });
  return input.content;
}

function appendUnsupportedVisionNotice(content: string, images: AgentUserImagePayload[]): string {
  const lines = [content.trimEnd()];
  lines.push(
    `[Note: The user attached ${images.length} image${images.length === 1 ? "" : "s"} (image IDs: ${images
      .map((image) => image.id)
      .join(
        ", ",
      )}), but the current model is not configured for vision, so the image content is not available to you.]`,
  );
  return lines.filter((line) => line.length > 0).join("\n");
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
    const fallbackUsage = buildUsageFromTokenColumns(message);
    if (fallbackUsage != null) {
      return fallbackUsage;
    }
    throw new Error(`Stored assistant message ${message.id} is missing usageJson`);
  }

  try {
    return JSON.parse(message.usageJson) as Usage;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Stored assistant message ${message.id} has invalid usageJson: ${detail}`);
  }
}

function buildUsageFromTokenColumns(message: Message): Usage | null {
  if (
    message.tokenInput == null ||
    message.tokenOutput == null ||
    message.tokenCacheRead == null ||
    message.tokenCacheWrite == null ||
    message.tokenTotal == null
  ) {
    return null;
  }

  return {
    input: message.tokenInput,
    output: message.tokenOutput,
    cacheRead: message.tokenCacheRead,
    cacheWrite: message.tokenCacheWrite,
    totalTokens: message.tokenTotal,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
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
