import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  AvailableAgentUserAttachmentPayload,
  UnavailableUserAttachmentReason,
  UserAttachmentKind,
} from "@/src/attachments/types.js";
import { withFileLock } from "@/src/shared/file-lock.js";

const UPLOADS_DIRNAME = "uploads";
const MAX_STORED_FILENAME_BYTES = 240;
const MAX_EXTENSION_BYTES = 20;
const ATTACHMENT_LOCK_TIMEOUT_MS = 3 * 60 * 1_000;
const ATTACHMENT_LOCK_STALE_AFTER_MS = 5 * 60 * 1_000;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PORTABLE_UNSAFE_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');

export interface InboundAttachmentResource {
  stream: Readable;
  mimeType: string;
  contentLength?: number;
}

export interface SaveInboundAttachmentInput {
  workspaceDir: string;
  messageId: string;
  sourceId: string;
  kind: UserAttachmentKind;
  originalName?: string;
  createdAt?: Date;
  resource: InboundAttachmentResource;
  maxBytes: number;
}

export class InboundAttachmentStoreError extends Error {
  readonly reason: UnavailableUserAttachmentReason;
  readonly maxBytes: number | undefined;

  constructor(
    reason: UnavailableUserAttachmentReason,
    message: string,
    options: { cause?: unknown; maxBytes?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InboundAttachmentStoreError";
    this.reason = reason;
    this.maxBytes = options.maxBytes;
  }
}

export class FilesystemInboundAttachmentStore {
  async save(input: SaveInboundAttachmentInput): Promise<AvailableAgentUserAttachmentPayload> {
    validateSaveInput(input);

    const workspaceDir = path.resolve(input.workspaceDir);
    const shortHash = buildInboundAttachmentShortHash(input.sourceId);
    const normalizedName = normalizeInboundAttachmentName({
      kind: input.kind,
      mimeType: input.resource.mimeType,
      ...(input.originalName == null ? {} : { originalName: input.originalName }),
    });
    const storedName = appendShortHash(normalizedName, shortHash);
    const dateSegment = resolveDateSegment(input.createdAt);
    const messageSegment = normalizePathSegment(input.messageId, "message");
    const relativePath = path.join(UPLOADS_DIRNAME, dateSegment, messageSegment, storedName);
    const localPath = path.resolve(workspaceDir, relativePath);
    assertPathWithinWorkspace(workspaceDir, localPath);

    if (input.resource.contentLength != null && input.resource.contentLength > input.maxBytes) {
      input.resource.stream.destroy();
      throw new InboundAttachmentStoreError(
        "too_large",
        `Attachment exceeds the ${input.maxBytes} byte limit`,
        { maxBytes: input.maxBytes },
      );
    }
    if (input.resource.contentLength === 0) {
      input.resource.stream.destroy();
      throw new InboundAttachmentStoreError("empty", "Attachment resource is empty");
    }

    const sizeBytes = await withFileLock(
      localPath,
      async () => {
        const existingSize = await readReusableFileSize(localPath, input.maxBytes);
        if (existingSize != null) {
          input.resource.stream.destroy();
          return existingSize;
        }

        const targetDir = path.dirname(localPath);
        await mkdir(targetDir, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(targetDir, `.${storedName}.${randomUUID()}.part`);
        let writtenBytes = 0;
        const byteLimiter = new Transform({
          transform(chunk: Buffer | string, _encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            writtenBytes += buffer.length;
            if (writtenBytes > input.maxBytes) {
              callback(
                new InboundAttachmentStoreError(
                  "too_large",
                  `Attachment exceeds the ${input.maxBytes} byte limit`,
                  { maxBytes: input.maxBytes },
                ),
              );
              return;
            }
            callback(null, buffer);
          },
        });

        try {
          await pipeline(
            input.resource.stream,
            byteLimiter,
            createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
          );
          if (writtenBytes === 0) {
            throw new InboundAttachmentStoreError("empty", "Attachment resource is empty");
          }
          await rename(temporaryPath, localPath);
          return writtenBytes;
        } catch (error) {
          await rm(temporaryPath, { force: true });
          if (error instanceof InboundAttachmentStoreError) {
            throw error;
          }
          throw new InboundAttachmentStoreError(
            "download_failed",
            "Failed to save inbound attachment",
            { cause: error },
          );
        }
      },
      {
        timeoutMs: ATTACHMENT_LOCK_TIMEOUT_MS,
        staleAfterMs: ATTACHMENT_LOCK_STALE_AFTER_MS,
      },
    );

    return {
      type: "attachment",
      status: "available",
      kind: input.kind,
      name: normalizedName,
      localPath,
      relativePath,
      mimeType: normalizeMimeType(input.resource.mimeType),
      sizeBytes,
    };
  }
}

export function buildInboundAttachmentShortHash(sourceId: string): string {
  return createHash("sha256").update(sourceId).digest("hex").slice(0, 8);
}

export function normalizeInboundAttachmentName(input: {
  originalName?: string;
  kind: UserAttachmentKind;
  mimeType: string;
}): string {
  const fallbackExtension = extensionFromMimeType(input.mimeType) ?? ".bin";
  const rawBasename = extractPortableBasename(input.originalName ?? "").normalize("NFC");
  const parsed = path.parse(rawBasename);
  const normalizedExtension = normalizeExtension(parsed.ext, fallbackExtension);
  const fallbackStem = input.kind === "file" ? "file" : input.kind;
  let normalizedStem = normalizeStem(parsed.name || rawBasename, fallbackStem);
  const suffixBudget = Buffer.byteLength(normalizedExtension, "utf8");
  normalizedStem = truncateUtf8(normalizedStem, MAX_STORED_FILENAME_BYTES - suffixBudget - 11);
  if (normalizedStem.length === 0) {
    normalizedStem = fallbackStem;
  }
  return `${normalizedStem}${normalizedExtension}`;
}

export async function readStoredAttachment(pathname: string): Promise<Buffer> {
  return await readFile(pathname);
}

function validateSaveInput(input: SaveInboundAttachmentInput): void {
  if (!path.isAbsolute(input.workspaceDir)) {
    throw new Error(`Attachment workspace must be absolute: ${input.workspaceDir}`);
  }
  if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new Error("Attachment maxBytes must be a positive integer");
  }
  if (input.messageId.trim().length === 0) {
    throw new Error("Attachment messageId must not be empty");
  }
  if (input.sourceId.trim().length === 0) {
    throw new Error("Attachment sourceId must not be empty");
  }
}

async function readReusableFileSize(localPath: string, maxBytes: number): Promise<number | null> {
  try {
    const fileStat = await lstat(localPath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxBytes) {
      await rm(localPath, { force: true });
      return null;
    }
    return fileStat.size;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function appendShortHash(fileName: string, shortHash: string): string {
  const parsed = path.parse(fileName);
  return `${parsed.name}--${shortHash}${parsed.ext}`;
}

function extractPortableBasename(value: string): string {
  const slashNormalized = value.replace(/\\/g, "/");
  return slashNormalized.slice(slashNormalized.lastIndexOf("/") + 1).trim();
}

function normalizeStem(value: string, fallback: string): string {
  let normalized = replaceUnsafeFilenameCharacters(value, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s_-]+|[.\s_-]+$/g, "");
  if (normalized.length === 0) {
    normalized = fallback;
  }
  if (WINDOWS_RESERVED_BASENAME.test(normalized)) {
    normalized = `${fallback}-${normalized}`;
  }
  return normalized;
}

function normalizeExtension(value: string, fallback: string): string {
  const candidate = replaceUnsafeFilenameCharacters(value.normalize("NFC"), "")
    .replace(/\s+/g, "")
    .replace(/\.+/g, ".");
  if (
    !candidate.startsWith(".") ||
    candidate === "." ||
    Buffer.byteLength(candidate, "utf8") > MAX_EXTENSION_BYTES
  ) {
    return fallback;
  }
  return candidate;
}

function replaceUnsafeFilenameCharacters(value: string, replacement: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      codePoint === 0x7f ||
      PORTABLE_UNSAFE_FILENAME_CHARACTERS.has(character)
      ? replacement
      : character;
  }).join("");
}

function normalizePathSegment(value: string, fallback: string): string {
  const normalized = normalizeStem(value.normalize("NFC"), fallback);
  return truncateUtf8(normalized, 96) || fallback;
}

function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function extensionFromMimeType(value: string): string | null {
  switch (normalizeMimeType(value)) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/tiff":
      return ".tiff";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return ".ico";
    case "image/heic":
      return ".heic";
    case "application/pdf":
      return ".pdf";
    case "text/markdown":
      return ".md";
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    case "application/zip":
      return ".zip";
    case "audio/opus":
      return ".opus";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "video/quicktime":
      return ".mov";
    default:
      return null;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function resolveDateSegment(value: Date | undefined): string {
  const date = value == null || Number.isNaN(value.getTime()) ? new Date() : value;
  return date.toISOString().slice(0, 10);
}

function assertPathWithinWorkspace(workspaceDir: string, localPath: string): void {
  const relative = path.relative(workspaceDir, localPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Attachment path escapes workspace: ${localPath}`);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
