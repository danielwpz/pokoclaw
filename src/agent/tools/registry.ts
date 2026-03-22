import type { ToolDefinition, ToolExecutionContext, ToolResult } from "@/src/agent/tools/types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor(tools: ToolDefinition[] = []) {
    this.registerMany(tools);
  }

  register<TArgs, TDetails>(tool: ToolDefinition<TArgs, TDetails>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  getRequired(name: string): ToolDefinition {
    const tool = this.get(name);
    if (tool == null) {
      throw new Error(`Tool not found: ${name}`);
    }

    return tool;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async execute(
    name: string,
    context: ToolExecutionContext,
    rawArgs: unknown,
  ): Promise<ToolResult> {
    const tool = this.getRequired(name);
    const args = tool.validateArgs == null ? rawArgs : tool.validateArgs(rawArgs);

    return await tool.execute(context, args);
  }
}
