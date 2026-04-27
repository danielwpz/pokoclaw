import type { StorageDb } from "@/src/storage/db/client.js";
import { ChannelSurfacesRepo } from "@/src/storage/repos/channel-surfaces.repo.js";
import { ChannelThreadsRepo } from "@/src/storage/repos/channel-threads.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";

const LARK_CHANNEL_TYPE = "lark";

export interface LarkDeliveryTarget {
  channelInstallationId: string;
  surfaceObject: Record<string, unknown>;
}

export function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function listLarkDeliveryTargets(
  storage: StorageDb,
  input: {
    conversationId: string;
    branchId: string;
    taskRunId?: string | null;
  },
): LarkDeliveryTarget[] {
  const surfaces = new ChannelSurfacesRepo(storage).listByConversationBranch({
    channelType: LARK_CHANNEL_TYPE,
    conversationId: input.conversationId,
    branchId: input.branchId,
  });
  const taskRun =
    input.taskRunId == null ? null : new TaskRunsRepo(storage).getById(input.taskRunId);
  const channelThreadsRepo = new ChannelThreadsRepo(storage);

  return surfaces.map((surface) => {
    const threadBinding =
      taskRun == null
        ? null
        : channelThreadsRepo.getByRootTaskRun({
            channelType: LARK_CHANNEL_TYPE,
            channelInstallationId: surface.channelInstallationId,
            rootTaskRunId: taskRun.threadRootRunId ?? taskRun.id,
          });

    return {
      channelInstallationId: surface.channelInstallationId,
      surfaceObject:
        threadBinding == null
          ? parseSurfaceObject(surface.surfaceObjectJson)
          : {
              chat_id: threadBinding.externalChatId,
              thread_id: threadBinding.externalThreadId,
              ...(threadBinding.openedFromMessageId == null
                ? {}
                : { reply_to_message_id: threadBinding.openedFromMessageId }),
            },
    };
  });
}

function parseSurfaceObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  return {};
}
