import { randomUUID } from "node:crypto";
import type { SessionRunAbortRegistry } from "@/src/agent/cancel.js";
import {
  type CompactionDecision,
  type CompactionReason,
  decideCompaction,
} from "@/src/agent/compaction.js";
import type { ModelScenario, ResolvedModel } from "@/src/agent/llm/models.js";
import type { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { AgentSessionService } from "@/src/agent/session.js";
import type { ToolRegistry } from "@/src/agent/tools/registry.js";
import type { CompactionConfig } from "@/src/config/schema.js";
import type { Logger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import type { MessagesRepo, MessageUsage } from "@/src/storage/repos/messages.repo.js";
import type { Message } from "@/src/storage/schema/types.js";

export interface AgentToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface AgentModelTurnResult {
  text?: string;
  toolCalls?: AgentToolCall[];
  usage?: MessageUsage | null;
}

export interface AgentModelTurnInput {
  sessionId: string;
  conversationId: string;
  scenario: ModelScenario;
  model: ResolvedModel;
  compactSummary: string | null;
  messages: Message[];
  signal: AbortSignal;
}

export interface AgentModelRunner {
  runTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult>;
}

export type AgentLoopEvent =
  | {
      type: "assistant_message";
      sessionId: string;
      messageId: string;
      text: string;
      toolCalls: AgentToolCall[];
    }
  | {
      type: "tool_call";
      sessionId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool_result";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      messageId: string;
    }
  | {
      type: "compaction_requested";
      sessionId: string;
      reason: CompactionReason;
      thresholdTokens: number;
      effectiveWindow: number;
    };

export interface RunAgentLoopInput {
  sessionId: string;
  scenario: ModelScenario;
  maxTurns?: number;
}

export interface RunAgentLoopResult {
  sessionId: string;
  scenario: ModelScenario;
  modelId: string;
  appendedMessageIds: string[];
  toolExecutions: number;
  compaction: CompactionDecision;
  events: AgentLoopEvent[];
}

export interface AgentLoopDependencies {
  sessions: AgentSessionService;
  messages: MessagesRepo;
  models: ProviderRegistry;
  tools: ToolRegistry;
  cancel: SessionRunAbortRegistry;
  modelRunner: AgentModelRunner;
  storage: StorageDb;
  logger: Logger;
  compaction: CompactionConfig;
  now?: () => Date;
  createId?: () => string;
}

export class AgentLoop {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly deps: AgentLoopDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? (() => randomUUID());
  }

  async run(input: RunAgentLoopInput): Promise<RunAgentLoopResult> {
    const handle = this.deps.cancel.begin(input.sessionId);
    const maxTurns = input.maxTurns ?? 8;
    const context = this.deps.sessions.getContext(input.sessionId);
    const model = this.deps.models.getRequiredScenarioModel(input.scenario);
    const messages = [...context.messages];
    const events: AgentLoopEvent[] = [];
    const appendedMessageIds: string[] = [];
    let toolExecutions = 0;
    let nextSeq = this.deps.messages.getNextSeq(input.sessionId);

    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        throwIfAborted(handle.signal);

        const response = await this.deps.modelRunner.runTurn({
          sessionId: input.sessionId,
          conversationId: context.session.conversationId,
          scenario: input.scenario,
          model,
          compactSummary: context.compactSummary,
          messages,
          signal: handle.signal,
        });

        throwIfAborted(handle.signal);

        const assistantMessageId = this.createId();
        const assistantText = response.text ?? "";
        const toolCalls = response.toolCalls ?? [];
        const assistantMessage = appendMessageAndHydrate({
          repo: this.deps.messages,
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          seq: nextSeq,
          role: "assistant",
          messageType: "text",
          visibility: "user_visible",
          content: {
            text: assistantText,
            toolCalls,
          },
          usage: response.usage ?? null,
          createdAt: this.now(),
        });
        nextSeq += 1;
        messages.push(assistantMessage);
        appendedMessageIds.push(assistantMessageId);
        events.push({
          type: "assistant_message",
          sessionId: input.sessionId,
          messageId: assistantMessageId,
          text: assistantText,
          toolCalls,
        });

        if (toolCalls.length === 0) {
          break;
        }

        for (const toolCall of toolCalls) {
          throwIfAborted(handle.signal);

          events.push({
            type: "tool_call",
            sessionId: input.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });

          const result = await this.deps.tools.execute(
            toolCall.name,
            {
              sessionId: input.sessionId,
              conversationId: context.session.conversationId,
              storage: this.deps.storage,
              logger: this.deps.logger,
              abortSignal: handle.signal,
              toolCallId: toolCall.id,
            },
            toolCall.args,
          );

          throwIfAborted(handle.signal);

          const toolResultMessageId = this.createId();
          const toolResultMessage = appendMessageAndHydrate({
            repo: this.deps.messages,
            sessionId: input.sessionId,
            messageId: toolResultMessageId,
            seq: nextSeq,
            role: "tool",
            messageType: "tool_result",
            visibility: "hidden_system",
            content: {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result,
            },
            createdAt: this.now(),
          });
          nextSeq += 1;
          messages.push(toolResultMessage);
          appendedMessageIds.push(toolResultMessageId);
          toolExecutions += 1;
          events.push({
            type: "tool_result",
            sessionId: input.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            messageId: toolResultMessageId,
          });
        }
      }

      const compaction = decideCompaction({
        contextTokens: estimateContextTokens(context.compactSummary, messages),
        contextWindow: model.contextWindow,
        config: this.deps.compaction,
      });

      if (compaction.shouldCompact && compaction.reason != null) {
        events.push({
          type: "compaction_requested",
          sessionId: input.sessionId,
          reason: compaction.reason,
          thresholdTokens: compaction.thresholdTokens,
          effectiveWindow: compaction.effectiveWindow,
        });
      }

      return {
        sessionId: input.sessionId,
        scenario: input.scenario,
        modelId: model.id,
        appendedMessageIds,
        toolExecutions,
        compaction,
        events,
      };
    } finally {
      handle.finish();
    }
  }
}

function appendMessageAndHydrate(input: {
  repo: MessagesRepo;
  sessionId: string;
  messageId: string;
  seq: number;
  role: string;
  messageType: string;
  visibility: string;
  content: unknown;
  usage?: MessageUsage | null;
  createdAt: Date;
}): Message {
  const contentJson = JSON.stringify(input.content);
  input.repo.append({
    id: input.messageId,
    sessionId: input.sessionId,
    seq: input.seq,
    role: input.role,
    messageType: input.messageType,
    visibility: input.visibility,
    contentJson,
    usage: input.usage ?? null,
    createdAt: input.createdAt,
  });

  return {
    id: input.messageId,
    sessionId: input.sessionId,
    seq: input.seq,
    role: input.role,
    messageType: input.messageType,
    visibility: input.visibility,
    channelMessageId: null,
    contentJson,
    tokenInput: input.usage?.input ?? null,
    tokenOutput: input.usage?.output ?? null,
    tokenCacheRead: input.usage?.cacheRead ?? null,
    tokenCacheWrite: input.usage?.cacheWrite ?? null,
    tokenTotal: input.usage?.totalTokens ?? null,
    usageJson: input.usage == null ? null : JSON.stringify(input.usage),
    createdAt: input.createdAt.toISOString(),
  };
}

function estimateContextTokens(compactSummary: string | null, messages: Message[]): number {
  let total = compactSummary == null ? 0 : estimateTextTokens(compactSummary);

  for (const message of messages) {
    total += message.tokenTotal ?? estimateTextTokens(message.contentJson);
  }

  return total;
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  throw new Error(typeof reason === "string" ? reason : "Operation aborted");
}
