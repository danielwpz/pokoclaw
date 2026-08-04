import { Buffer } from "node:buffer";

import {
  InboundAttachmentStoreError,
  normalizeInboundAttachmentName,
  readStoredAttachment,
} from "@/src/attachments/store.js";
import type {
  AgentUserAttachmentPayload,
  UnavailableAgentUserAttachmentPayload,
  UserAttachmentKind,
} from "@/src/attachments/types.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import type { SessionInboundAttachmentStore } from "@/src/orchestration/inbound-attachments.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-inbound-attachments");

export interface LarkInboundAttachmentDescriptor {
  kind: UserAttachmentKind;
  resourceKey: string;
  resourceType: "image" | "file";
  originalName?: string;
}

export interface LarkInboundImageAsset {
  id: string;
  messageId: string;
  data: string;
  mimeType: string;
}

export interface ProcessedLarkInboundAttachments {
  attachments: AgentUserAttachmentPayload[];
  imageAssets: LarkInboundImageAsset[];
}

export function extractLarkInboundAttachmentDescriptors(
  messageType: string,
  content: string,
): LarkInboundAttachmentDescriptor[] {
  if (content.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
      return [];
    }

    const descriptors: LarkInboundAttachmentDescriptor[] = [];
    switch (messageType) {
      case "image":
        appendDescriptor(descriptors, {
          kind: "image",
          resourceKey: readString(parsed.image_key),
          resourceType: "image",
        });
        break;
      case "file":
        appendDescriptor(descriptors, {
          kind: "file",
          resourceKey: readString(parsed.file_key),
          resourceType: "file",
          originalName: readString(parsed.file_name),
        });
        break;
      case "audio":
        appendDescriptor(descriptors, {
          kind: "audio",
          resourceKey: readString(parsed.file_key),
          resourceType: "file",
        });
        break;
      case "media":
        appendDescriptor(descriptors, {
          kind: "video",
          resourceKey: readString(parsed.file_key),
          resourceType: "file",
          originalName: readString(parsed.file_name),
        });
        break;
      case "post": {
        const body = unwrapLarkPostContent(parsed);
        const paragraphs = Array.isArray(body?.content) ? body.content : [];
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) {
            continue;
          }
          for (const element of paragraph) {
            if (!isRecord(element)) {
              continue;
            }
            const tag = readString(element.tag);
            if (tag === "img") {
              appendDescriptor(descriptors, {
                kind: "image",
                resourceKey: readString(element.image_key),
                resourceType: "image",
              });
              continue;
            }
            if (tag === "media") {
              appendDescriptor(descriptors, {
                kind: "video",
                resourceKey: readString(element.file_key),
                resourceType: "file",
                originalName: readString(element.file_name),
              });
              continue;
            }
            if (tag === "file") {
              appendDescriptor(descriptors, {
                kind: "file",
                resourceKey: readString(element.file_key),
                resourceType: "file",
                originalName: readString(element.file_name),
              });
            }
          }
        }
        break;
      }
      default:
        break;
    }

    return dedupeDescriptors(descriptors);
  } catch {
    return [];
  }
}

export async function processLarkInboundAttachments(input: {
  installationId: string;
  sessionId: string;
  messageId: string;
  createdAt?: Date;
  descriptors: LarkInboundAttachmentDescriptor[];
  clients: {
    getOrCreate(installationId: string): LarkSdkClient;
  };
  attachmentStore?: SessionInboundAttachmentStore;
}): Promise<ProcessedLarkInboundAttachments> {
  if (input.descriptors.length === 0) {
    return { attachments: [], imageAssets: [] };
  }

  const client = input.clients.getOrCreate(input.installationId);
  const attachments: AgentUserAttachmentPayload[] = [];
  const imageAssets: LarkInboundImageAsset[] = [];

  for (const descriptor of input.descriptors) {
    let mimeType = normalizeLarkResourceMimeType(descriptor.kind, undefined);
    try {
      const response = await client.sdk.im.messageResource.get({
        path: {
          message_id: input.messageId,
          file_key: descriptor.resourceKey,
        },
        params: {
          type: descriptor.resourceType,
        },
      });
      mimeType = normalizeLarkResourceMimeType(
        descriptor.kind,
        readHeader(response.headers, "content-type"),
      );
      const contentLength = parseContentLength(readHeader(response.headers, "content-length"));

      if (input.attachmentStore == null) {
        if (descriptor.kind === "image") {
          const buffer = await readLarkResourceBuffer(response.getReadableStream());
          if (buffer.length === 0) {
            throw new Error("empty lark inbound image resource");
          }
          imageAssets.push({
            id: descriptor.resourceKey,
            messageId: input.messageId,
            data: buffer.toString("base64"),
            mimeType,
          });
        } else {
          response.getReadableStream().destroy();
          logger.warn("skipping lark inbound file because attachment storage is not configured", {
            installationId: input.installationId,
            messageId: input.messageId,
            kind: descriptor.kind,
          });
        }
        continue;
      }

      const saved = await input.attachmentStore.save({
        sessionId: input.sessionId,
        messageId: input.messageId,
        sourceId: buildLarkAttachmentSourceId(input, descriptor),
        kind: descriptor.kind,
        ...(descriptor.originalName == null ? {} : { originalName: descriptor.originalName }),
        ...(input.createdAt == null ? {} : { createdAt: input.createdAt }),
        resource: {
          stream: response.getReadableStream(),
          mimeType,
          ...(contentLength == null ? {} : { contentLength }),
        },
      });
      attachments.push(saved);

      if (descriptor.kind === "image") {
        try {
          const buffer = await readStoredAttachment(saved.localPath);
          imageAssets.push({
            id: descriptor.resourceKey,
            messageId: input.messageId,
            data: buffer.toString("base64"),
            mimeType: saved.mimeType,
          });
        } catch (error) {
          logger.warn("saved lark image but failed to prepare first-turn vision data", {
            installationId: input.installationId,
            messageId: input.messageId,
            localPath: saved.localPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info("saved lark inbound attachment", {
        installationId: input.installationId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        kind: saved.kind,
        name: saved.name,
        localPath: saved.localPath,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
      });
    } catch (error) {
      logger.warn("failed to process lark inbound attachment", {
        installationId: input.installationId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        kind: descriptor.kind,
        resourceType: descriptor.resourceType,
        error: error instanceof Error ? error.message : String(error),
      });
      if (input.attachmentStore != null) {
        attachments.push(buildUnavailableAttachment(descriptor, error, mimeType));
      }
    }
  }

  return { attachments, imageAssets };
}

function appendDescriptor(
  descriptors: LarkInboundAttachmentDescriptor[],
  input: {
    kind: UserAttachmentKind;
    resourceKey: string | null;
    resourceType: "image" | "file";
    originalName?: string | null;
  },
): void {
  if (input.resourceKey == null) {
    return;
  }
  descriptors.push({
    kind: input.kind,
    resourceKey: input.resourceKey,
    resourceType: input.resourceType,
    ...(input.originalName == null ? {} : { originalName: input.originalName }),
  });
}

function dedupeDescriptors(
  descriptors: LarkInboundAttachmentDescriptor[],
): LarkInboundAttachmentDescriptor[] {
  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    const key = `${descriptor.resourceType}:${descriptor.resourceKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildLarkAttachmentSourceId(
  input: { installationId: string; messageId: string },
  descriptor: LarkInboundAttachmentDescriptor,
): string {
  return [
    "lark",
    input.installationId,
    input.messageId,
    descriptor.resourceType,
    descriptor.resourceKey,
  ].join(":");
}

function buildUnavailableAttachment(
  descriptor: LarkInboundAttachmentDescriptor,
  error: unknown,
  mimeType: string,
): UnavailableAgentUserAttachmentPayload {
  const storedError = error instanceof InboundAttachmentStoreError ? error : null;
  const name = normalizeInboundAttachmentName({
    kind: descriptor.kind,
    mimeType,
    ...(descriptor.originalName == null ? {} : { originalName: descriptor.originalName }),
  });
  return {
    type: "attachment",
    status: "unavailable",
    kind: descriptor.kind,
    name,
    reason: storedError?.reason ?? "download_failed",
    ...(storedError?.maxBytes == null ? {} : { maxBytes: storedError.maxBytes }),
  };
}

async function readLarkResourceBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeLarkResourceMimeType(kind: UserAttachmentKind, value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.split(";")[0]?.trim().toLowerCase();
    if (normalized != null && normalized.length > 0) {
      if (kind !== "image" || normalized.startsWith("image/")) {
        return normalized;
      }
    }
  }
  return kind === "image" ? "image/png" : "application/octet-stream";
}

function parseContentLength(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readHeader(headers: unknown, name: string): unknown {
  if (!isRecord(headers)) {
    return undefined;
  }
  const expectedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expectedName) {
      return value;
    }
  }
  return undefined;
}

function unwrapLarkPostContent(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if ("title" in parsed || "content" in parsed) {
    return parsed;
  }
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const localized = parsed[locale];
    if (isRecord(localized)) {
      return localized;
    }
  }
  const firstLocalized = Object.values(parsed).find((value) => isRecord(value));
  return isRecord(firstLocalized) ? firstLocalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
