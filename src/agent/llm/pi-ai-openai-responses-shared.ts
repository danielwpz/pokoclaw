/**
 * Vendored OpenAI Responses helpers from `@mariozechner/pi-ai@0.58.0`.
 *
 * This module exists because [`upstream-openai.ts`](./upstream-openai.ts) needs
 * OpenAI Responses conversion + streaming helpers, but the upstream package does
 * not publicly export them. Depending on a relative path inside `node_modules`
 * would leak package internals into production code and would be fragile across
 * dependency upgrades.
 *
 * Vendored source files from `@mariozechner/pi-ai@0.58.0`:
 * - `dist/providers/openai-responses-shared.js`
 * - `dist/providers/transform-messages.js`
 * - `dist/utils/sanitize-unicode.js`
 * - `dist/utils/hash.js`
 * - the tiny `calculateCost()` helper logic from `dist/models.js`
 *
 * Intentional constraints for this file:
 * - Preserve upstream runtime behavior as closely as possible.
 * - Only make the minimum changes needed to localize imports and satisfy local
 *   typing/linting requirements.
 * - Do not refactor behavior here casually. Treat it as a compatibility layer.
 *
 * When upgrading `@mariozechner/pi-ai`, diff the files above against this local
 * copy and re-run the Responses stream tests plus full `pnpm preflight`.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  StopReason,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { parseStreamingJson } from "@mariozechner/pi-ai";
import type {
  Tool as OpenAITool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

export interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

export interface ConvertResponsesMessagesOptions {
  includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
}

interface TextSignature {
  id: string;
  phase?: "commentary" | "final_answer";
}

type StreamThinkingBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type StreamTextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
type StreamToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }> & {
  partialJson?: string;
};
type StreamBlock = StreamThinkingBlock | StreamTextBlock | StreamToolCallBlock;

interface ResponsesReasoningSummaryPart {
  text: string;
}

interface ResponsesReasoningItem {
  type: "reasoning";
  id?: string;
  summary?: ResponsesReasoningSummaryPart[];
}

interface ResponsesOutputTextPart {
  type: "output_text";
  text: string;
}

interface ResponsesRefusalPart {
  type: "refusal";
  refusal: string;
}

type ResponsesMessagePart = ResponsesOutputTextPart | ResponsesRefusalPart;

interface ResponsesMessageItem {
  type: "message";
  id: string;
  phase?: "commentary" | "final_answer";
  content?: ResponsesMessagePart[];
}

interface ResponsesFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments?: string;
}

type ResponsesStreamItem =
  | ResponsesReasoningItem
  | ResponsesMessageItem
  | ResponsesFunctionCallItem;

function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  const payload: { v: 1; id: string; phase?: "commentary" | "final_answer" } = { v: 1, id };
  if (phase) payload.phase = phase;
  return JSON.stringify(payload);
}

function parseTextSignature(signature?: string): TextSignature | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: number; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // Fall through to legacy plain-string handling.
    }
  }
  return { id: signature };
}

function transformMessages(
  messages: Message[],
  model: Model<Api>,
  normalizeToolCallId?: (
    id: string,
    model: Model<Api>,
    assistantMessage: AssistantMessage,
  ) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();

  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }

    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }

    const assistantMsg = msg;
    const isSameModel =
      assistantMsg.provider === model.provider &&
      assistantMsg.api === model.api &&
      assistantMsg.model === model.id;

    const transformedContent = assistantMsg.content.flatMap((block) => {
      if (block.type === "thinking") {
        if (block.redacted) {
          return isSameModel ? block : [];
        }
        if (isSameModel && block.thinkingSignature) return block;
        if (!block.thinking || block.thinking.trim() === "") return [];
        if (isSameModel) return block;
        return {
          type: "text" as const,
          text: block.thinking,
        };
      }

      if (block.type === "text") {
        if (isSameModel) return block;
        return {
          type: "text" as const,
          text: block.text,
        };
      }

      if (block.type === "toolCall") {
        let normalizedToolCall: typeof block = block;
        if (!isSameModel && block.thoughtSignature) {
          normalizedToolCall = { ...block };
          delete normalizedToolCall.thoughtSignature;
        }
        if (!isSameModel && normalizeToolCallId) {
          const normalizedId = normalizeToolCallId(block.id, model, assistantMsg);
          if (normalizedId !== block.id) {
            toolCallIdMap.set(block.id, normalizedId);
            normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
          }
        }
        return normalizedToolCall;
      }

      return block;
    });

    return {
      ...assistantMsg,
      content: transformedContent,
    };
  });

  const result: Message[] = [];
  let pendingToolCalls = transformed.flatMap(() => [] as AssistantMessage["content"]);
  let existingToolResultIds = new Set<string>();

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        for (const tc of pendingToolCalls) {
          if (tc.type !== "toolCall" || existingToolResultIds.has(tc.id)) continue;
          result.push({
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: "text", text: "No result provided" }],
            isError: true,
            timestamp: Date.now(),
          });
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set<string>();
      }

      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }

      const toolCalls = msg.content.filter((block) => block.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set<string>();
      }
      result.push(msg);
      continue;
    }

    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }

    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (tc.type !== "toolCall" || existingToolResultIds.has(tc.id)) continue;
        result.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        });
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set<string>();
    }
    result.push(msg);
  }

  return result;
}

export function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponseInput {
  const messages: Array<Record<string, unknown>> = [];
  const normalizeToolCallId = (id: string) => {
    if (!allowedToolCallProviders.has(model.provider)) return id;
    if (!id.includes("|")) return id;

    const [callId = "", itemId = ""] = id.split("|");
    const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!sanitizedItemId.startsWith("fc")) {
      sanitizedItemId = `fc_${sanitizedItemId}`;
    }

    let normalizedCallId =
      sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
    let normalizedItemId =
      sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
    normalizedCallId = normalizedCallId.replace(/_+$/, "");
    normalizedItemId = normalizedItemId.replace(/_+$/, "");
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model as Model<Api>, (id) =>
    normalizeToolCallId(id),
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;

  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      role: model.reasoning ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
        });
      } else {
        const content = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "input_text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`,
          };
        });
        const filteredContent = !model.input.includes("image")
          ? content.filter((item) => item.type !== "input_image")
          : content;
        if (filteredContent.length === 0) continue;
        messages.push({
          role: "user",
          content: filteredContent,
        });
      }
    } else if (msg.role === "assistant") {
      const output: Array<Record<string, unknown>> = [];
      const assistantMsg = msg;
      const isDifferentModel =
        assistantMsg.model !== model.id &&
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api;

      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature) as Record<string, unknown>);
          }
        } else if (block.type === "text") {
          const parsedSignature = parseTextSignature(block.textSignature);
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }

          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] },
            ],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          let itemId = itemIdRaw;
          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = undefined;
          }
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }

      if (output.length === 0) continue;
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");
      const hasImages = msg.content.some((content) => content.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");

      let output: unknown;
      if (hasImages && model.input.includes("image")) {
        const contentParts: Array<Record<string, unknown>> = [];
        if (hasText) {
          contentParts.push({
            type: "input_text",
            text: sanitizeSurrogates(textResult),
          });
        }
        for (const block of msg.content) {
          if (block.type !== "image") continue;
          contentParts.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${block.mimeType};base64,${block.data}`,
          });
        }
        output = contentParts;
      } else {
        output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
      }

      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }

    msgIndex++;
  }

  return messages as unknown as ResponseInput;
}

export function convertResponsesTools(
  tools: Tool[],
  options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
  const strict = options?.strict === undefined ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    strict,
  }));
}

export async function processResponsesStream<TApi extends Api>(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
  options?: OpenAIResponsesStreamOptions,
): Promise<void> {
  let currentItem: ResponsesStreamItem | null = null;
  let currentBlock: StreamBlock | null = null;
  const blocks = output.content as StreamBlock[];
  const blockIndex = () => blocks.length - 1;

  for await (const event of openaiStream) {
    if (event.type === "response.output_item.added") {
      const item = event.item as unknown as ResponsesStreamItem;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        blocks.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        blocks.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || "",
        };
        blocks.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part as unknown as ResponsesReasoningSummaryPart);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output,
          });
        }
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part as unknown as ResponsesMessagePart);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) continue;
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) continue;
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output,
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output,
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item as unknown as ResponsesStreamItem;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = item.summary?.map((summary) => summary.text).join("\n\n") || "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = (item.content ?? [])
          .map((content) => (content.type === "output_text" ? content.text : content.refusal))
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(currentBlock.partialJson)
            : parseStreamingJson(item.arguments || "{}");
        const toolCall = {
          type: "toolCall" as const,
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: args,
        };
        currentBlock = null;
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall,
          partial: output,
        });
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = response?.service_tier ?? options.serviceTier;
        options.applyServiceTierPricing(output.usage, serviceTier);
      }
      output.stopReason = mapStopReason(response?.status);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      throw Object.assign(
        new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error"),
        event.code == null ? {} : { code: event.code },
      );
    } else if (event.type === "response.failed") {
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const message = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw Object.assign(new Error(message), {
        ...(error?.code == null ? {} : { code: error.code }),
        response: {
          ...(error == null ? {} : { error }),
          ...(details == null ? {} : { incompleteDetails: details }),
        },
      });
    }
  }
}

function mapStopReason(status?: string): StopReason {
  if (!status) return "stop";

  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}
