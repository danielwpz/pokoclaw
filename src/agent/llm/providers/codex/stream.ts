import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { buildAgentLlmRawErrorPayload } from "@/src/agent/llm/errors.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@/src/agent/llm/pi-ai-openai-responses-shared.js";

type ResponsesInput = Exclude<ResponseCreateParamsStreaming["input"], undefined>;
type RequestServiceTier = ResponseCreateParamsStreaming["service_tier"];

export type CodexResponsesStreamOptions = SimpleStreamOptions & {
  codexAccountId?: string;
  serviceTier?: RequestServiceTier;
  onPayload?: (
    payload: unknown,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;
};

type AssistantMessageWithRawError = AssistantMessage & {
  pokoclawRawError?: ReturnType<typeof buildAgentLlmRawErrorPayload>;
};

const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);
const CODEX_FAILED_RESPONSE_STATUSES = new Set(["failed", "cancelled"]);

export function streamOpenAICodexResponsesWithLocalConverter(
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: CodexResponsesStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error("OpenAI-compatible API key is missing");
      }

      const requestServiceTier = options?.serviceTier;
      const client = new OpenAI({
        apiKey,
        baseURL: resolveCodexResponsesBaseUrl(model),
        defaultHeaders: buildCodexDefaultHeaders(
          apiKey,
          options?.sessionId,
          options?.codexAccountId,
        ),
        dangerouslyAllowBrowser: true,
      });

      const params = await applyPayloadHook(
        buildOpenAICodexResponsesParams(model, context, options),
        model,
        options,
      );
      const rawStream = await client.responses.create(
        params as ResponseCreateParamsStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      );

      stream.push({ type: "start", partial: output });
      await processResponsesStream(
        withResolvedCodexServiceTier(
          mapCodexResponsesEvents(rawStream as AsyncIterable<Record<string, unknown>>),
          requestServiceTier,
        ),
        output,
        stream,
        model,
        {
          serviceTier: requestServiceTier,
          applyServiceTierPricing: (usage, serviceTier) =>
            applyCodexServiceTierPricing(model, usage, serviceTier),
        },
      );

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      (output as AssistantMessageWithRawError).pokoclawRawError =
        buildAgentLlmRawErrorPayload(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function buildOpenAICodexResponsesParams(
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: CodexResponsesStreamOptions,
): ResponseCreateParamsStreaming {
  const input: ResponsesInput = normalizeResponsesInputRoles(
    convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
      includeSystemPrompt: false,
    }),
  );
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input,
    stream: true,
    store: false,
    instructions: context.systemPrompt,
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    max_output_tokens: model.maxTokens,
  } as ResponseCreateParamsStreaming;

  if (options?.sessionId) {
    params.prompt_cache_key = options.sessionId;
  }

  if (options?.serviceTier) {
    params.service_tier = options.serviceTier;
  }

  if (context.tools != null && context.tools.length > 0) {
    params.tools = convertResponsesTools(context.tools as Tool[], { strict: null });
    params.tool_choice = "auto";
    params.parallel_tool_calls = true;
  }

  if (model.reasoning && options?.reasoning) {
    params.reasoning = {
      effort: clampCodexReasoningEffort(model.id, options.reasoning),
      summary: "auto",
    };
  }

  return params;
}

export async function* mapCodexResponsesEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncIterable<ResponseStreamEvent> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;

    switch (type) {
      case "error":
        throw new Error(`Codex error: ${readCodexErrorMessage(event)}`);
      case "response.done":
      case "response.completed":
      case "response.incomplete":
        yield normalizeCodexTerminalEvent(event, type);
        continue;
      case "response.output_item.added":
      case "response.output_item.done":
        validateCodexOutputItemEvent(event, type);
        yield event as unknown as ResponseStreamEvent;
        continue;
      case "response.content_part.added":
        validateCodexContentPartEvent(event, type);
        yield event as unknown as ResponseStreamEvent;
        continue;
      case "response.output_text.delta":
      case "response.refusal.delta":
      case "response.function_call_arguments.delta":
      case "response.reasoning_summary_text.delta":
        requireStringField(event, "delta", type, "delta");
        yield event as unknown as ResponseStreamEvent;
        continue;
      case "response.function_call_arguments.done":
        requireStringField(event, "arguments", type, "arguments");
        yield event as unknown as ResponseStreamEvent;
        continue;
      case "response.reasoning_summary_part.added":
        validateReasoningSummaryPartEvent(event, type);
        yield event as unknown as ResponseStreamEvent;
        continue;
      default:
        yield event as unknown as ResponseStreamEvent;
        continue;
    }
  }
}

async function* withResolvedCodexServiceTier(
  events: AsyncIterable<ResponseStreamEvent>,
  requestServiceTier: RequestServiceTier | undefined,
): AsyncIterable<ResponseStreamEvent> {
  for await (const event of events) {
    if (
      event.type !== "response.completed" ||
      event.response == null ||
      requestServiceTier == null
    ) {
      yield event;
      continue;
    }

    const responseServiceTier = event.response.service_tier;
    const serviceTier =
      responseServiceTier == null || responseServiceTier === "default"
        ? requestServiceTier
        : responseServiceTier;
    yield {
      ...event,
      response: {
        ...event.response,
        service_tier: serviceTier,
      },
    };
  }
}

async function applyPayloadHook(
  params: ResponseCreateParamsStreaming,
  model: Model<"openai-codex-responses">,
  options?: CodexResponsesStreamOptions,
): Promise<unknown> {
  const nextParams = await options?.onPayload?.(params, model);
  return nextParams ?? params;
}

function resolveCodexResponsesBaseUrl(model: Model<"openai-codex-responses">): string {
  const normalized = model.baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized.slice(0, -"/responses".length);
  }
  if (normalized.endsWith("/codex")) {
    return normalized;
  }
  return `${normalized}/codex`;
}

function buildCodexDefaultHeaders(
  token: string,
  sessionId: string | undefined,
  accountId: string | undefined,
): Record<string, string> {
  const resolvedAccountId =
    accountId != null && accountId.length > 0 ? accountId : extractCodexAccountId(token);
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    "chatgpt-account-id": resolvedAccountId,
    originator: "pi",
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) {
    headers.session_id = sessionId;
    headers["x-client-request-id"] = sessionId;
  }
  return headers;
}

function extractCodexAccountId(token: string): string {
  try {
    const [, payload] = token.split(".");
    if (!payload) {
      throw new Error("missing payload");
    }
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      [CODEX_JWT_AUTH_CLAIM]?: { chatgpt_account_id?: unknown };
    };
    const accountId = parsed[CODEX_JWT_AUTH_CLAIM]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("missing account id");
    }
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

function clampCodexReasoningEffort(
  modelId: string,
  effort: NonNullable<SimpleStreamOptions["reasoning"]>,
): NonNullable<SimpleStreamOptions["reasoning"]> {
  const id = modelId.includes("/") ? (modelId.split("/").at(-1) ?? modelId) : modelId;
  if (
    (id.startsWith("gpt-5.2") ||
      id.startsWith("gpt-5.3") ||
      id.startsWith("gpt-5.4") ||
      id.startsWith("gpt-5.5")) &&
    effort === "minimal"
  ) {
    return "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") {
    return "high";
  }
  if (id === "gpt-5.1-codex-mini") {
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  }
  return effort;
}

function normalizeCodexTerminalEvent(
  event: Record<string, unknown>,
  type: "response.done" | "response.completed" | "response.incomplete",
): ResponseStreamEvent {
  const response = requireRecordField(event, "response", type, "response");
  const fallbackStatus =
    type === "response.completed"
      ? "completed"
      : type === "response.incomplete"
        ? "incomplete"
        : undefined;
  const status = normalizeCodexResponseStatus(response.status, type) ?? fallbackStatus;
  const normalizedResponse = {
    ...response,
    ...(status == null ? {} : { status }),
  };
  const normalizedType =
    status != null && CODEX_FAILED_RESPONSE_STATUSES.has(status)
      ? "response.failed"
      : "response.completed";
  return {
    ...event,
    type: normalizedType,
    response: normalizedResponse,
  } as unknown as ResponseStreamEvent;
}

function normalizeCodexResponseStatus(value: unknown, eventType: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !CODEX_RESPONSE_STATUSES.has(value)) {
    throw invalidCodexEvent(eventType, "response.status must be a known Codex status");
  }
  return value;
}

function validateCodexOutputItemEvent(event: Record<string, unknown>, eventType: string): void {
  const item = requireRecordField(event, "item", eventType, "item");
  const itemType = requireStringField(item, "type", eventType, "item.type");

  if (itemType === "message") {
    requireStringField(item, "id", eventType, "item.id");
    validateMessageContentParts(item.content, eventType, "item.content");
    return;
  }

  if (itemType === "function_call") {
    requireStringField(item, "id", eventType, "item.id");
    requireStringField(item, "call_id", eventType, "item.call_id");
    requireStringField(item, "name", eventType, "item.name");
    if (item.arguments != null && typeof item.arguments !== "string") {
      throw invalidCodexEvent(eventType, "item.arguments must be a string");
    }
    return;
  }

  if (itemType === "reasoning") {
    if (item.id != null && typeof item.id !== "string") {
      throw invalidCodexEvent(eventType, "item.id must be a string");
    }
    if (item.summary != null && !Array.isArray(item.summary)) {
      throw invalidCodexEvent(eventType, "item.summary must be an array");
    }
  }
}

function validateCodexContentPartEvent(event: Record<string, unknown>, eventType: string): void {
  const part = requireRecordField(event, "part", eventType, "part");
  validateMessagePart(part, eventType, "part");
}

function validateReasoningSummaryPartEvent(
  event: Record<string, unknown>,
  eventType: string,
): void {
  const part = requireRecordField(event, "part", eventType, "part");
  requireStringField(part, "text", eventType, "part.text");
}

function validateMessageContentParts(value: unknown, eventType: string, path: string): void {
  if (value == null) {
    return;
  }
  if (!Array.isArray(value)) {
    throw invalidCodexEvent(eventType, `${path} must be an array`);
  }
  value.forEach((part, index) => {
    if (!isRecord(part)) {
      throw invalidCodexEvent(eventType, `${path}[${index}] must be an object`);
    }
    validateMessagePart(part, eventType, `${path}[${index}]`);
  });
}

function validateMessagePart(part: Record<string, unknown>, eventType: string, path: string): void {
  const partType = requireStringField(part, "type", eventType, `${path}.type`);
  if (partType === "output_text") {
    requireStringField(part, "text", eventType, `${path}.text`);
  } else if (partType === "refusal") {
    requireStringField(part, "refusal", eventType, `${path}.refusal`);
  }
}

function readCodexErrorMessage(event: Record<string, unknown>): string {
  const code = typeof event.code === "string" ? event.code : "";
  const message = typeof event.message === "string" ? event.message : "";
  return message || code || JSON.stringify(event);
}

function requireRecordField(
  value: Record<string, unknown>,
  key: string,
  eventType: string,
  path: string,
): Record<string, unknown> {
  const candidate = value[key];
  if (!isRecord(candidate)) {
    throw invalidCodexEvent(eventType, `${path} must be an object`);
  }
  return candidate;
}

function requireStringField(
  value: Record<string, unknown>,
  key: string,
  eventType: string,
  path: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    throw invalidCodexEvent(eventType, `${path} must be a string`);
  }
  return candidate;
}

function invalidCodexEvent(eventType: string, message: string): Error {
  return new Error(`Invalid Codex ${eventType} event: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> & { role?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResponsesInputRoles(input: ResponsesInput): ResponsesInput {
  if (!Array.isArray(input)) {
    return input;
  }

  let changed = false;
  const normalized = input.map((item) => {
    if (!isRecord(item) || item.role !== "developer") {
      return item;
    }

    changed = true;
    return {
      ...item,
      role: "system" as const,
    };
  });

  return changed ? normalized : input;
}

function applyCodexServiceTierPricing(
  model: Model<"openai-codex-responses">,
  usage: Usage,
  serviceTier: RequestServiceTier | undefined,
): void {
  const multiplier = getCodexServiceTierCostMultiplier(model.id, serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function getCodexServiceTierCostMultiplier(
  modelId: string,
  serviceTier: RequestServiceTier | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return modelId === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
