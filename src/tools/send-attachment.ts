import { stat } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";

import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import {
  formatDisplayPath,
  requireFilesystemAccess,
  resolveToolCwd,
} from "@/src/tools/helpers/common.js";

const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_TYPES = [
  "image",
  "pdf",
  "word",
  "spreadsheet",
  "presentation",
  "html",
  "file",
] as const;

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const SEND_ATTACHMENT_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String({
      description:
        "Absolute or relative path to a local file to attach in the current conversation.",
    }),
    type: Type.Optional(
      Type.Union(
        ATTACHMENT_TYPES.map((attachmentType) => Type.Literal(attachmentType)),
        {
          description:
            "Optional expected attachment type. Use image for PNG/JPEG/WEBP/GIF/BMP/TIFF/ICO files.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export type SendAttachmentToolArgs = Static<typeof SEND_ATTACHMENT_TOOL_SCHEMA>;

export interface SendAttachmentToolDetails {
  path: string;
  absolutePath: string;
  type: AttachmentType;
  eventId: string;
  queued: true;
}

export function createSendAttachmentTool() {
  return defineTool({
    name: "send_attachment",
    description:
      "Attach a local file in the current conversation through the active channel's native attachment capability. Use this whenever the user asks you to send, show, share, or deliver a local image or file after creating or locating it. Set type to image for image files. Do not substitute Markdown links, file paths, text cards, or A2UI for an actual chat attachment when this tool is available. Image files must be non-empty JPEG, PNG, WEBP, GIF, TIFF, BMP, or ICO files and under 10 MB; other attachment types are queued only when the channel supports them.",
    inputSchema: SEND_ATTACHMENT_TOOL_SCHEMA,
    async execute(context, args) {
      if (context.runtimeControl?.sendAttachment == null) {
        throw toolInternalError("send_attachment is not configured in this runtime.");
      }

      const cwd = resolveToolCwd(context);
      const absolutePath = requireFilesystemAccess(context, {
        kind: "fs.read",
        targetPath: args.path,
      });
      const displayPath = formatDisplayPath(args.path, cwd);

      let fileStats: Awaited<ReturnType<typeof stat>>;
      try {
        fileStats = await stat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw toolRecoverableError(`Attachment file not found: ${displayPath}`, {
            code: "file_not_found",
            path: absolutePath,
          });
        }
        throw error;
      }
      if (!fileStats.isFile()) {
        throw toolRecoverableError(`Path is not a regular file: ${displayPath}`, {
          code: "not_a_file",
          path: absolutePath,
        });
      }
      if (fileStats.size <= 0) {
        throw toolRecoverableError(`Attachment file is empty: ${displayPath}`, {
          code: "empty_file",
          path: absolutePath,
        });
      }
      const attachmentType = args.type ?? inferAttachmentType(displayPath);
      if (attachmentType === "image" && !hasSupportedImageExtension(displayPath)) {
        throw toolRecoverableError(
          `Attachment type "image" requires a supported image extension (PNG, JPEG, WEBP, GIF, TIFF, BMP, ICO): ${displayPath}`,
          {
            code: "unsupported_image_format",
            path: absolutePath,
            displayPath,
          },
        );
      }
      const maxBytes =
        attachmentType === "image" ? MAX_OUTBOUND_IMAGE_BYTES : MAX_OUTBOUND_ATTACHMENT_BYTES;
      if (fileStats.size > maxBytes) {
        throw toolRecoverableError(
          `Attachment file is larger than ${bytesToMegabytes(maxBytes)} MB: ${displayPath}`,
          {
            code: "file_too_large",
            path: absolutePath,
            sizeBytes: fileStats.size,
            maxBytes,
          },
        );
      }

      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Source session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "chat" && session.purpose !== "task") {
        throw toolRecoverableError("send_attachment is only available in chat or task sessions.", {
          code: "send_attachment_wrong_session_purpose",
          sessionPurpose: session.purpose,
        });
      }

      const result = await context.runtimeControl.sendAttachment({
        sourceSessionId: context.sessionId,
        conversationId: context.conversationId,
        branchId: session.branchId,
        ...(context.taskRunId === undefined ? {} : { taskRunId: context.taskRunId }),
        attachmentPath: absolutePath,
        displayPath,
        type: attachmentType,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
      });

      return textToolResult(`Queued attachment ${displayPath} for sending.`, {
        path: displayPath,
        absolutePath,
        type: attachmentType,
        eventId: result.eventId,
        queued: true,
      } satisfies SendAttachmentToolDetails);
    },
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function inferAttachmentType(displayPath: string): AttachmentType {
  const normalized = displayPath.toLowerCase();
  if (hasSupportedImageExtension(normalized)) {
    return "image";
  }
  if (normalized.endsWith(".pdf")) {
    return "pdf";
  }
  if (/\.(docx?|rtf)$/.test(normalized)) {
    return "word";
  }
  if (/\.(xlsx?|csv|tsv)$/.test(normalized)) {
    return "spreadsheet";
  }
  if (/\.(pptx?|key)$/.test(normalized)) {
    return "presentation";
  }
  if (/\.(html?|xhtml)$/.test(normalized)) {
    return "html";
  }
  return "file";
}

function hasSupportedImageExtension(displayPath: string): boolean {
  return /\.(png|jpe?g|webp|gif|tiff?|bmp|ico)$/i.test(displayPath);
}

function bytesToMegabytes(bytes: number): number {
  return bytes / 1024 / 1024;
}
