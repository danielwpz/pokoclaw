import { createBashTool } from "@/src/tools/bash.js";
import { createEditTool } from "@/src/tools/edit.js";
import { createFindTool } from "@/src/tools/find.js";
import { createGrepTool } from "@/src/tools/grep.js";
import { createLsTool } from "@/src/tools/ls.js";
import { createReadTool } from "@/src/tools/read.js";
import { ToolRegistry } from "@/src/tools/registry.js";
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
  return registry;
}
