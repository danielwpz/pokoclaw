import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { AppConfig } from "@/src/config/schema.js";
import { type A2uiPublisher, createPublishA2uiTool } from "@/src/tools/a2ui-publish.js";
import { createBackgroundTaskTool } from "@/src/tools/background-task.js";
import { createBashTool } from "@/src/tools/bash.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createCreateSubagentTool } from "@/src/tools/create-subagent.js";
import { createScheduleTaskTool } from "@/src/tools/cron.js";
import { createEditTool } from "@/src/tools/edit.js";
import { createFinishTaskTool } from "@/src/tools/finish-task.js";
import { createGetRuntimeStatusTool } from "@/src/tools/get-runtime-status.js";
import { createGrepTool } from "@/src/tools/grep.js";
import { createListBackgroundTasksTool } from "@/src/tools/list-background-tasks.js";
import { createListDirTool } from "@/src/tools/list-dir.js";
import { createLsTool } from "@/src/tools/ls.js";
import { createQuerySystemDbTool } from "@/src/tools/query-system-db.js";
import { createReadTool } from "@/src/tools/read.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import { createReviewPermissionRequestTool } from "@/src/tools/review-permission-request.js";
import { createWaitTaskTool } from "@/src/tools/wait-task.js";
import { createWebFetchTool } from "@/src/tools/web/fetch.js";
import { createWebSearchTool } from "@/src/tools/web/search.js";
import { createWriteTool } from "@/src/tools/write.js";

export function createBuiltinToolRegistry(
  config?: Pick<AppConfig, "providers" | "tools">,
  integrations: {
    a2uiPublisher?: A2uiPublisher;
  } = {},
): ToolRegistry {
  const providers = config?.providers ?? DEFAULT_CONFIG.providers;
  const toolsConfig = config?.tools ?? DEFAULT_CONFIG.tools;
  const registry = new ToolRegistry();
  registry.register(createBashTool());
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createLsTool());
  registry.register(createListDirTool());
  registry.register(createGrepTool());
  registry.register(createQuerySystemDbTool());
  registry.register(createGetRuntimeStatusTool());
  registry.register(createFinishTaskTool());
  registry.register(createRequestPermissionsTool());
  registry.register(createReviewPermissionRequestTool());
  registry.register(createCreateSubagentTool());
  registry.register(createScheduleTaskTool());
  registry.register(createBackgroundTaskTool());
  registry.register(createWaitTaskTool());
  registry.register(createListBackgroundTasksTool());
  registry.register(
    createPublishA2uiTool(
      integrations.a2uiPublisher == null ? {} : { publisher: integrations.a2uiPublisher },
    ),
  );
  if (toolsConfig.web.search.enabled) {
    const providerId = toolsConfig.web.search.provider;
    const providerConfig = providerId == null ? null : (providers[providerId] ?? null);
    if (providerId == null || providerConfig == null) {
      throw new Error("tools.web.search is enabled but its provider is not configured.");
    }
    registry.register(
      createWebSearchTool({
        providerId,
        providerConfig,
      }),
    );
  }
  if (toolsConfig.web.fetch.enabled) {
    const providerId = toolsConfig.web.fetch.provider;
    const providerConfig = providerId == null ? null : (providers[providerId] ?? null);
    if (providerId == null || providerConfig == null) {
      throw new Error("tools.web.fetch is enabled but its provider is not configured.");
    }
    registry.register(
      createWebFetchTool({
        providerId,
        providerConfig,
      }),
    );
  }
  return registry;
}
