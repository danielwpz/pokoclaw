import { type Static, Type } from "@sinclair/typebox";
import type {
  ShellProcessOutputChunk,
  ShellProcessView,
} from "@/src/runtime/shell-process-manager.js";
import type { ShellProcessRun } from "@/src/storage/schema/types.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult, type ToolExecutionContext } from "@/src/tools/core/types.js";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_LOG_CHARS = 32_000;

export const PROCESS_TOOL_SCHEMA = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("poll"),
      Type.Literal("log"),
      Type.Literal("kill"),
    ]),
    processRunId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Managed process id returned by bash. Required for poll, log, and kill.",
      }),
    ),
    afterCursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        default: 0,
        description: "For poll/log, return output after this cursor. Defaults to 0.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        default: DEFAULT_LIST_LIMIT,
        description: "For list, maximum number of process records to return.",
      }),
    ),
    maxChars: Type.Optional(
      Type.Integer({
        minimum: 256,
        maximum: 128_000,
        default: DEFAULT_LOG_CHARS,
        description: "For poll/log, maximum output characters returned in this call.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ProcessToolArgs = Static<typeof PROCESS_TOOL_SCHEMA>;

export function createProcessTool() {
  return defineTool({
    name: "process",
    description:
      "Inspect or stop Pokoclaw-managed shell processes. Use list to find processRunIds, poll/log with afterCursor for incremental output, and kill to terminate the whole managed process tree.",
    inputSchema: PROCESS_TOOL_SCHEMA,
    getResultMaxChars(_context, args) {
      return args.action === "poll" || args.action === "log"
        ? (args.maxChars ?? DEFAULT_LOG_CHARS) + 4_000
        : 16_000;
    },
    async execute(context, args) {
      const { manager, ownerAgentId } = requireManagedProcessContext(context);
      if (args.action === "list") {
        return jsonToolResult({
          processes: manager
            .list(ownerAgentId, args.limit ?? DEFAULT_LIST_LIMIT)
            .map(renderProcessSummary),
        });
      }

      const processRunId = args.processRunId?.trim();
      if (processRunId == null || processRunId.length === 0) {
        throw toolRecoverableError(
          `process action=${args.action} requires \`processRunId\`. Use action=list to find available process ids.`,
          {
            code: "process_run_id_required",
            action: args.action,
          },
        );
      }

      const view =
        args.action === "kill"
          ? await manager.kill({
              id: processRunId,
              ownerAgentId,
              suppressCompletionNotice: true,
            })
          : manager.get({
              id: processRunId,
              ownerAgentId,
              afterCursor: args.afterCursor ?? 0,
            });
      if (
        args.action !== "kill" &&
        view.processRun.status !== "starting" &&
        view.processRun.status !== "running"
      ) {
        manager.suppressCompletionNotice(processRunId, ownerAgentId);
      }
      return jsonToolResult(renderProcessView(view, args.maxChars ?? DEFAULT_LOG_CHARS));
    },
  });
}

function requireManagedProcessContext(context: ToolExecutionContext): {
  manager: NonNullable<ToolExecutionContext["shellProcesses"]>;
  ownerAgentId: string;
} {
  const ownerAgentId = context.ownerAgentId?.trim();
  if (ownerAgentId == null || ownerAgentId.length === 0) {
    throw toolRecoverableError("The process tool is missing its owner agent context.", {
      code: "missing_owner_agent",
    });
  }
  if (context.shellProcesses == null) {
    throw toolRecoverableError("Managed shell processes are unavailable in this runtime.", {
      code: "shell_process_manager_unavailable",
    });
  }
  return { manager: context.shellProcesses, ownerAgentId };
}

function renderProcessSummary(processRun: ShellProcessRun) {
  return {
    processRunId: processRun.id,
    status: processRun.status,
    command: processRun.commandPreview,
    cwd: processRun.cwd,
    pid: processRun.pid,
    sandboxMode: processRun.sandboxMode,
    timeoutMs: processRun.timeoutMs,
    startedAt: processRun.startedAt,
    finishedAt: processRun.finishedAt,
    durationMs: processRun.durationMs,
    exitCode: processRun.exitCode,
    exitSignal: processRun.exitSignal,
    exitReason: processRun.exitReason,
    outputTruncated: processRun.outputTruncated,
  };
}

function renderProcessView(view: ShellProcessView, maxChars: number) {
  const limited = limitOutputChunks(view.output.chunks, maxChars, view.output.nextCursor);
  return {
    process: renderProcessSummary(view.processRun),
    output: {
      chunks: limited.chunks,
      nextCursor: limited.nextCursor,
      availableThroughCursor: view.output.nextCursor,
      hasMore: limited.nextCursor < view.output.nextCursor,
      truncatedBefore: view.output.truncatedBefore,
      outputTruncated: view.output.outputTruncated,
    },
    errorText: view.processRun.errorText,
  };
}

function limitOutputChunks(
  chunks: ShellProcessOutputChunk[],
  maxChars: number,
  fallbackCursor: number,
): { chunks: ShellProcessOutputChunk[]; nextCursor: number } {
  let remaining = maxChars;
  const selected: ShellProcessOutputChunk[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) {
      break;
    }
    const text = chunk.text.slice(0, remaining);
    selected.push({
      ...chunk,
      cursorEnd: chunk.cursorStart + text.length,
      text,
    });
    remaining -= text.length;
    if (text.length < chunk.text.length) {
      break;
    }
  }
  return {
    chunks: selected,
    nextCursor: selected.at(-1)?.cursorEnd ?? chunks[0]?.cursorStart ?? fallbackCursor,
  };
}
