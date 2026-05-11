import type { ToolDefinition, ToolSourceMetadata } from "@/src/tools/core/types.js";

export const BUILTIN_TOOL_SOURCE: ToolSourceMetadata = {
  kind: "builtin",
  id: "builtin",
  displayName: "Built-in tools",
  diagnosticsName: "builtin",
};

export interface ToolSource {
  readonly metadata: ToolSourceMetadata;
  list(): readonly ToolDefinition[];
}

export class StaticToolSource implements ToolSource {
  readonly metadata: ToolSourceMetadata;
  private readonly tools: ToolDefinition[];

  constructor(input: { metadata: ToolSourceMetadata; tools: readonly ToolDefinition[] }) {
    this.metadata = input.metadata;
    this.tools = input.tools.map((tool) => attachToolSource(tool, input.metadata));
  }

  list(): readonly ToolDefinition[] {
    return this.tools;
  }
}

export function attachToolSource<TArgs, TDetails>(
  tool: ToolDefinition<TArgs, TDetails>,
  source: ToolSourceMetadata,
): ToolDefinition<TArgs, TDetails> {
  if (tool.source != null) {
    return tool;
  }

  return {
    ...tool,
    source,
  };
}
