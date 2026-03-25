import { normalizeToolFailure } from "@/src/tools/core/errors.js";
import {
  parseToolArgs,
  ToolArgumentValidationError,
  type ToolDefinition,
  type ToolExecutionContext,
  ToolLookupError,
  type ToolResult,
} from "@/src/tools/core/types.js";

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
      throw new ToolLookupError(name);
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
    try {
      const tool = this.getRequired(name);
      const args =
        tool.inputSchema == null ? rawArgs : parseToolArgs(tool.name, tool.inputSchema, rawArgs);

      return await tool.execute(context, args);
    } catch (error) {
      if (error instanceof ToolLookupError || error instanceof ToolArgumentValidationError) {
        throw normalizeToolFailure(error);
      }

      throw error;
    }
  }
}
