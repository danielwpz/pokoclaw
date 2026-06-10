import { parseBindingMetadata, readLarkHttpStatus } from "@/src/channels/lark/cardkit-mutations.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { readStringValue } from "@/src/channels/lark/delivery-targets.js";
import { uploadLarkImageMessageAsset } from "@/src/channels/lark/image-message.js";
import type { LarkTaskCardImage } from "@/src/channels/lark/render.js";
import type { LarkRunState } from "@/src/channels/lark/run-state.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-task-card-images");

interface CachedTaskResultImage {
  path: string;
  displayPath: string;
  alt?: string;
  imageKey: string;
}

interface CachedTaskResultImageFailure {
  path: string;
  displayPath: string;
  alt?: string;
  error: string;
  httpStatus?: number;
}

export async function resolveTaskCardImages(input: {
  channelInstallationId: string;
  chatId: string;
  client: LarkSdkClient;
  state: LarkRunState;
  metadataJson: string;
  cacheMetadataJson?: string | null;
}): Promise<{ metadataJson: string; images: LarkTaskCardImage[] }> {
  if (input.state.terminalImageAttachments.length === 0) {
    return {
      metadataJson: input.metadataJson,
      images: [],
    };
  }

  const metadata = parseBindingMetadata(input.metadataJson);
  const cacheMetadata = parseBindingMetadata(input.cacheMetadataJson ?? input.metadataJson);
  const cachedImages = readCachedTaskResultImages(cacheMetadata.taskResultImages);
  const cachedFailures = readCachedTaskResultImageFailures(cacheMetadata.taskResultImageFailures);
  const nextCache: CachedTaskResultImage[] = [];
  const nextFailures: CachedTaskResultImageFailure[] = [];
  const images: LarkTaskCardImage[] = [];

  for (const attachment of input.state.terminalImageAttachments) {
    const cached = cachedImages.find((item) => item.path === attachment.path) ?? null;
    const cachedFailure = cachedFailures.find((item) => item.path === attachment.path) ?? null;
    if (cachedFailure != null) {
      nextFailures.push(cachedFailure);
      continue;
    }

    let imageKey = cached?.imageKey ?? null;
    if (imageKey == null) {
      try {
        const uploaded = await uploadLarkImageMessageAsset({
          installationId: input.channelInstallationId,
          chatId: input.chatId,
          imagePath: attachment.path,
          clients: {
            getOrCreate: (installationId) => {
              if (installationId !== input.channelInstallationId) {
                throw new Error(`Unexpected lark installation id ${installationId}`);
              }
              return input.client;
            },
          },
        });
        imageKey = uploaded.imageKey;
      } catch (error) {
        const httpStatus = readLarkHttpStatus(error);
        logger.error("failed to upload lark task result image for task card", {
          channelInstallationId: input.channelInstallationId,
          taskRunId: input.state.taskRunId,
          path: attachment.path,
          displayPath: attachment.displayPath,
          httpStatus,
          error: error instanceof Error ? error.message : String(error),
          responsePreview: truncateLogText(readLarkErrorResponsePreview(error), 300),
        });
        if (!isNonRetryableLarkImageUploadError(error)) {
          throw error;
        }

        nextFailures.push({
          path: attachment.path,
          displayPath: attachment.displayPath,
          ...(attachment.alt == null ? {} : { alt: attachment.alt }),
          error: error instanceof Error ? error.message : String(error),
          ...(httpStatus == null ? {} : { httpStatus }),
        });
        continue;
      }
    }

    const cachedImage: CachedTaskResultImage = {
      path: attachment.path,
      displayPath: attachment.displayPath,
      ...(attachment.alt == null ? {} : { alt: attachment.alt }),
      imageKey,
    };
    nextCache.push(cachedImage);
    images.push({
      imageKey,
      displayPath: attachment.displayPath,
      ...(attachment.alt == null ? {} : { alt: attachment.alt }),
    });
  }

  return {
    metadataJson: JSON.stringify({
      ...metadata,
      taskResultImages: nextCache,
      ...(nextFailures.length === 0 ? {} : { taskResultImageFailures: nextFailures }),
    }),
    images,
  };
}

function readCachedTaskResultImages(value: unknown): CachedTaskResultImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const images: CachedTaskResultImage[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const path = readStringValue(item.path);
    const displayPath = readStringValue(item.displayPath);
    const imageKey = readStringValue(item.imageKey);
    if (path == null || displayPath == null || imageKey == null) {
      continue;
    }
    const alt = readStringValue(item.alt);
    images.push({
      path,
      displayPath,
      imageKey,
      ...(alt == null ? {} : { alt }),
    });
  }
  return images;
}

function readCachedTaskResultImageFailures(value: unknown): CachedTaskResultImageFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const failures: CachedTaskResultImageFailure[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const path = readStringValue(item.path);
    const displayPath = readStringValue(item.displayPath);
    const error = readStringValue(item.error);
    if (path == null || displayPath == null || error == null) {
      continue;
    }
    const alt = readStringValue(item.alt);
    const httpStatus = typeof item.httpStatus === "number" ? item.httpStatus : null;
    failures.push({
      path,
      displayPath,
      error,
      ...(alt == null ? {} : { alt }),
      ...(httpStatus == null ? {} : { httpStatus }),
    });
  }
  return failures;
}

function isNonRetryableLarkImageUploadError(error: unknown): boolean {
  const httpStatus = readLarkHttpStatus(error);
  if (httpStatus == null) {
    return false;
  }

  return httpStatus >= 400 && httpStatus < 500 && ![408, 409, 429].includes(httpStatus);
}

function readLarkErrorResponsePreview(error: unknown): string {
  if (!isRecord(error)) {
    return "";
  }
  const response = error.response;
  if (!isRecord(response)) {
    return "";
  }
  return safeJson(response.data ?? response);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateLogText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
