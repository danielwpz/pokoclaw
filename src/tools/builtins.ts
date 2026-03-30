import { createBashTool } from "@/src/tools/bash.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { createCreateSubagentTool } from "@/src/tools/create-subagent.js";
import { createScheduleTaskTool } from "@/src/tools/cron.js";
import { createEditTool } from "@/src/tools/edit.js";
import { createFindTool } from "@/src/tools/find.js";
import { createFinishTaskTool } from "@/src/tools/finish-task.js";
import { createGrepTool } from "@/src/tools/grep.js";
import { createLsTool } from "@/src/tools/ls.js";
import { createReadTool } from "@/src/tools/read.js";
import { createRequestPermissionsTool } from "@/src/tools/request-permissions.js";
import { createReviewPermissionRequestTool } from "@/src/tools/review-permission-request.js";
import { createWriteTool } from "@/src/tools/write.js";

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createBashTool());
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createLsTool());
  registry.register(createFindTool());
  registry.register(createGrepTool());
  registry.register(createFinishTaskTool());
  registry.register(createRequestPermissionsTool());
  registry.register(createReviewPermissionRequestTool());
  registry.register(createCreateSubagentTool());
  registry.register(createScheduleTaskTool());
  return registry;
}
