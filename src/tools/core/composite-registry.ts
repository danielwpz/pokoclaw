import { normalizeToolFailure } from "@/src/tools/core/errors.js";
import { executeToolDefinition, type ToolRegistryLike } from "@/src/tools/core/registry.js";
import type { ToolSource } from "@/src/tools/core/source.js";
import { attachToolSource } from "@/src/tools/core/source.js";
import {
  type ToolDefinition,
  type ToolExecutionContext,
  ToolLookupError,
  type ToolResult,
} from "@/src/tools/core/types.js";

interface CompositeToolEntry {
  tool: ToolDefinition;
  source: ToolSource;
}

export class CompositeToolRegistry implements ToolRegistryLike {
  constructor(private readonly sources: readonly ToolSource[]) {}

  has(name: string): boolean {
    return this.get(name) != null;
  }

  get(name: string): ToolDefinition | null {
    return this.buildIndex().get(name)?.tool ?? null;
  }

  getRequired(name: string): ToolDefinition {
    const tool = this.get(name);
    if (tool == null) {
      throw new ToolLookupError(name);
    }

    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.buildIndex().values()].map((entry) => entry.tool);
  }

  async execute(
    name: string,
    context: ToolExecutionContext,
    rawArgs: unknown,
  ): Promise<ToolResult> {
    const entry = this.buildIndex().get(name);
    if (entry == null) {
      throw normalizeToolFailure(new ToolLookupError(name));
    }

    return await executeToolDefinition(entry.tool, name, context, rawArgs);
  }

  private buildIndex(): Map<string, CompositeToolEntry> {
    const index = new Map<string, CompositeToolEntry>();
    for (const source of this.sources) {
      for (const sourceTool of source.list()) {
        const tool = attachToolSource(sourceTool, source.metadata);
        const existing = index.get(tool.name);
        if (existing != null) {
          throw new Error(
            `Tool already registered: ${tool.name} from ${renderSource(
              existing.source,
            )} and ${renderSource(source)}`,
          );
        }

        index.set(tool.name, {
          tool,
          source,
        });
      }
    }

    return index;
  }
}

function renderSource(source: ToolSource): string {
  return source.metadata.diagnosticsName ?? source.metadata.id;
}
