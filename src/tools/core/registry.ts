import { createSubsystemLogger } from "@/src/shared/logger.js";
import { isToolApprovalRequired, normalizeToolFailure } from "@/src/tools/core/errors.js";
import {
  parseToolArgs,
  ToolArgumentValidationError,
  type ToolDefinition,
  type ToolExecutionContext,
  ToolLookupError,
  type ToolResult,
} from "@/src/tools/core/types.js";

const logger = createSubsystemLogger("tools");

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
    const startedAt = Date.now();
    logger.info("tool execution started", {
      toolName: name,
      toolCallId: context.toolCallId,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      cwd: context.cwd,
      args: truncateSerialized(rawArgs),
    });

    try {
      const tool = this.getRequired(name);
      const args =
        tool.inputSchema == null ? rawArgs : parseToolArgs(tool.name, tool.inputSchema, rawArgs);

      const result = await tool.execute(context, args);
      logger.info("tool execution finished", {
        toolName: name,
        toolCallId: context.toolCallId,
        sessionId: context.sessionId,
        success: true,
        durationMs: Date.now() - startedAt,
        result: summarizeToolResult(result),
      });

      return result;
    } catch (error) {
      if (isToolApprovalRequired(error)) {
        logger.info("tool execution waiting for approval", {
          toolName: name,
          toolCallId: context.toolCallId,
          sessionId: context.sessionId,
          durationMs: Date.now() - startedAt,
          reason: truncateText(error.reasonText, 160),
        });
        throw error;
      }

      if (error instanceof ToolLookupError || error instanceof ToolArgumentValidationError) {
        const normalized = normalizeToolFailure(error);
        logger.warn("tool execution finished", {
          toolName: name,
          toolCallId: context.toolCallId,
          sessionId: context.sessionId,
          success: false,
          durationMs: Date.now() - startedAt,
          errorKind: normalized.kind,
          errorMessage: truncateText(normalized.message, 160),
        });
        throw normalized;
      }

      logger.warn("tool execution finished", {
        toolName: name,
        toolCallId: context.toolCallId,
        sessionId: context.sessionId,
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: truncateText(error instanceof Error ? error.message : String(error), 160),
      });
      throw error;
    }
  }
}

function summarizeToolResult(result: ToolResult): string {
  return truncateSerialized(
    result.content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "json", json: block.json },
    ),
    240,
  );
}

function truncateSerialized(value: unknown, maxLength: number = 240): string {
  const serialized = safeSerialize(value);
  return truncateText(serialized, maxLength);
}

function safeSerialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
