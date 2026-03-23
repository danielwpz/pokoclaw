import { createEditTool } from "@/src/tools/edit.js";
import { createLsTool } from "@/src/tools/ls.js";
import { createReadTool } from "@/src/tools/read.js";
import { ToolRegistry } from "@/src/tools/registry.js";
import { createWriteTool } from "@/src/tools/write.js";

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createLsTool());
  return registry;
}
