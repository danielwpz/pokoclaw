import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  isToolApprovalRequired,
  normalizeToolFailure,
  toolRecoverableError,
} from "@/src/tools/core/errors.js";
import {
  parseToolArgs,
  type ToolContentBlock,
  type ToolDefinition,
  type ToolExecutionContext,
  ToolLookupError,
  type ToolResult,
} from "@/src/tools/core/types.js";

const logger = createSubsystemLogger("tools");
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 12_000;
export const TOOL_RESULT_TRUNCATION_NOTICE = "\n\n[Tool result truncated due to size limit.]";

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
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
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
      const timeoutMs = Math.max(
        1,
        Math.floor(tool.getInvocationTimeoutMs?.(context, args) ?? DEFAULT_TOOL_TIMEOUT_MS),
      );
      const resultMaxChars = Math.max(
        1,
        Math.floor(tool.getResultMaxChars?.(context, args) ?? DEFAULT_TOOL_RESULT_MAX_CHARS),
      );
      const timeoutController = new AbortController();
      const combinedAbortSignal =
        context.abortSignal == null
          ? timeoutController.signal
          : AbortSignal.any([context.abortSignal, timeoutController.signal]);
      const executionContext: ToolExecutionContext = {
        ...context,
        abortSignal: combinedAbortSignal,
      };
      const executionPromise = Promise.resolve(tool.execute(executionContext, args));
      executionPromise.catch(() => {});
      const rawResult = await Promise.race([
        executionPromise,
        new Promise<ToolResult>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
            reject(
              toolRecoverableError(`The ${name} tool timed out after ${timeoutMs}ms.`, {
                code: "tool_timeout",
                toolName: name,
                timeoutMs,
              }),
            );
          }, timeoutMs);
        }),
      ]);
      const result = truncateToolResult(rawResult, resultMaxChars);
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

      const normalized = normalizeToolFailure(error);
      logger.warn("tool execution finished", {
        toolName: name,
        toolCallId: context.toolCallId,
        sessionId: context.sessionId,
        success: false,
        durationMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true } : {}),
        errorKind: normalized.kind,
        errorMessage: truncateText(normalized.rawMessage ?? normalized.message, 160),
      });
      throw normalized;
    } finally {
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
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

function truncateToolResult(result: ToolResult, maxChars: number): ToolResult {
  const truncatedContent = truncateToolContentBlocks(result.content, maxChars);
  if (truncatedContent === result.content) {
    return result;
  }

  return {
    ...result,
    content: truncatedContent,
  };
}

function truncateToolContentBlocks(
  blocks: ToolContentBlock[],
  maxChars: number,
): ToolContentBlock[] {
  const serializedLength = blocks.reduce((total, block) => total + measureBlock(block), 0);
  if (serializedLength <= maxChars) {
    return blocks;
  }

  const truncated: ToolContentBlock[] = [];
  let remaining = Math.max(0, maxChars);
  for (const block of blocks) {
    if (remaining <= 0) {
      break;
    }

    const measured = measureBlock(block);
    if (measured <= remaining) {
      truncated.push(block);
      remaining -= measured;
      continue;
    }

    truncated.push(truncateBlock(block, remaining));
    remaining = 0;
    break;
  }

  return truncated;
}

function measureBlock(block: ToolContentBlock): number {
  return block.type === "text" ? block.text.length : safeSerialize(block.json).length;
}

function truncateBlock(block: ToolContentBlock, remaining: number): ToolContentBlock {
  const budget = Math.max(0, remaining - TOOL_RESULT_TRUNCATION_NOTICE.length);
  const source = block.type === "text" ? block.text : safeSerialize(block.json);
  const truncatedSource = budget <= 0 ? "" : source.slice(0, Math.max(0, budget));
  return {
    type: "text",
    text: `${truncatedSource}${TOOL_RESULT_TRUNCATION_NOTICE}`,
  };
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
