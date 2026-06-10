import { stat } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  TASK_COMPLETION_TOOL_NAME,
  type TaskCompletionDetails,
} from "@/src/tasks/task-completion.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";
import {
  formatDisplayPath,
  requireFilesystemAccess,
  resolveToolCwd,
} from "@/src/tools/helpers/common.js";

const MAX_FINISH_TASK_IMAGES = 5;
const MAX_FINISH_TASK_IMAGE_BYTES = 10 * 1024 * 1024;

const FINISH_TASK_STATUS_SCHEMA = Type.Union([
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);

export const FINISH_TASK_TOOL_SCHEMA = Type.Object(
  {
    status: FINISH_TASK_STATUS_SCHEMA,
    summary: Type.String({
      minLength: 1,
      description: "Short audit summary of the task outcome.",
    }),
    finalMessage: Type.String({
      minLength: 1,
      description:
        "Primary user-facing final result for this unattended task. This is shown on the task card.",
    }),
    images: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({
              minLength: 1,
              description:
                "Absolute or relative path to a local image file to show under finalMessage on the task card.",
            }),
            alt: Type.Optional(
              Type.String({
                description: "Short accessible description for this image.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        {
          maxItems: MAX_FINISH_TASK_IMAGES,
          description:
            "Optional local image files to include in the finish task card. Supports PNG, JPEG, WEBP, GIF, TIFF, BMP, and ICO files under 10 MB each.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

export type FinishTaskToolArgs = Static<typeof FINISH_TASK_TOOL_SCHEMA>;

export function createFinishTaskTool() {
  return defineTool({
    name: TASK_COMPLETION_TOOL_NAME,
    description:
      "Mark an unattended task session as completed, blocked, or failed. Use this only in task sessions. Always include a short summary plus the full finalMessage that should appear on the task card. Optionally include local image files in images to show them under the finalMessage on the task card. Calling this ends the current task run after the tool result is recorded.",
    inputSchema: FINISH_TASK_TOOL_SCHEMA,
    async execute(context, args) {
      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Task completion session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "task") {
        throw toolRecoverableError("finish_task is only available in unattended task sessions.", {
          code: "finish_task_wrong_session_purpose",
          sessionId: context.sessionId,
          sessionPurpose: session.purpose,
        });
      }

      const cwd = resolveToolCwd(context);
      const images = await Promise.all(
        (args.images ?? []).map(async (image) => {
          const absolutePath = requireFilesystemAccess(context, {
            kind: "fs.read",
            targetPath: image.path,
          });
          const displayPath = formatDisplayPath(image.path, cwd);
          await validateFinishTaskImage({
            absolutePath,
            displayPath,
          });
          const alt = normalizeOptionalString(image.alt);
          return {
            path: absolutePath,
            displayPath,
            ...(alt == null ? {} : { alt }),
          };
        }),
      );

      const details: TaskCompletionDetails = {
        taskCompletion: {
          status: args.status,
          summary: args.summary.trim(),
          finalMessage: args.finalMessage.trim(),
          ...(images.length === 0 ? {} : { images }),
        },
      };

      return textToolResult(`Recorded task completion with status=${args.status}.`, details);
    },
  });
}

async function validateFinishTaskImage(input: {
  absolutePath: string;
  displayPath: string;
}): Promise<void> {
  let fileStats: Awaited<ReturnType<typeof stat>>;
  try {
    fileStats = await stat(input.absolutePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw toolRecoverableError(`Task finish image not found: ${input.displayPath}`, {
        code: "file_not_found",
        path: input.absolutePath,
      });
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    throw toolRecoverableError(
      `Task finish image path is not a regular file: ${input.displayPath}`,
      {
        code: "not_a_file",
        path: input.absolutePath,
      },
    );
  }

  if (fileStats.size <= 0) {
    throw toolRecoverableError(`Task finish image file is empty: ${input.displayPath}`, {
      code: "empty_file",
      path: input.absolutePath,
    });
  }

  if (!hasSupportedImageExtension(input.displayPath)) {
    throw toolRecoverableError(
      `Task finish image requires a supported extension (PNG, JPEG, WEBP, GIF, TIFF, BMP, ICO): ${input.displayPath}`,
      {
        code: "unsupported_image_format",
        path: input.absolutePath,
        displayPath: input.displayPath,
      },
    );
  }

  if (fileStats.size > MAX_FINISH_TASK_IMAGE_BYTES) {
    throw toolRecoverableError(
      `Task finish image is larger than ${bytesToMegabytes(MAX_FINISH_TASK_IMAGE_BYTES)} MB: ${input.displayPath}`,
      {
        code: "file_too_large",
        path: input.absolutePath,
        sizeBytes: fileStats.size,
        maxBytes: MAX_FINISH_TASK_IMAGE_BYTES,
      },
    );
  }
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function hasSupportedImageExtension(displayPath: string): boolean {
  return /\.(png|jpe?g|webp|gif|tiff?|bmp|ico)$/i.test(displayPath);
}

function bytesToMegabytes(bytes: number): number {
  return bytes / 1024 / 1024;
}
