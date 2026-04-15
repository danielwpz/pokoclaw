export interface MeditationContextMessageLike {
  seq: number;
  createdAt: string;
  role: string;
  messageType: string;
  payloadJson: string;
}

type ParsedTextPayload = {
  content?: unknown;
};

type ParsedToolResultPayload = {
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
  content?: unknown;
};

const DEFAULT_ASSISTANT_TEXT_PREFIX = 40;
const DEFAULT_SUCCESS_OUTPUT_PREFIX = 160;

export function summarizeMeditationContextMessage(message: MeditationContextMessageLike): string {
  if (message.messageType === "tool_result") {
    return summarizeToolResultPayload(message.payloadJson);
  }

  if (message.messageType === "text") {
    return summarizeTextPayload(message.role, message.payloadJson);
  }

  return `[${message.messageType}]`;
}

function summarizeTextPayload(role: string, payloadJson: string): string {
  const payload = parseJson<ParsedTextPayload>(payloadJson);
  const text = extractTextContent(payload?.content);
  if (role === "user") {
    return text.length > 0 ? text : "[empty user text]";
  }
  if (role === "assistant") {
    return truncateText(text, DEFAULT_ASSISTANT_TEXT_PREFIX);
  }
  return truncateText(text, DEFAULT_ASSISTANT_TEXT_PREFIX);
}

function summarizeToolResultPayload(payloadJson: string): string {
  const payload = parseJson<ParsedToolResultPayload>(payloadJson);
  if (payload == null) {
    return "[tool_result payload parse failed]";
  }

  const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
  const isError = payload.isError === true;
  const details = asRecord(payload.details);
  const code = typeof details?.code === "string" ? details.code : null;
  const request = asRecord(details?.request);
  const requestSummary = request == null ? null : truncateText(JSON.stringify(request), 320);
  const outputText = extractTextContent(payload.content);
  const renderedOutput = isError
    ? outputText
    : truncateText(outputText, DEFAULT_SUCCESS_OUTPUT_PREFIX);

  const parts = [`tool=${toolName}`, `status=${isError ? "error" : "ok"}`];
  if (code != null) {
    parts.push(`code=${code}`);
  }
  if (requestSummary != null && requestSummary.length > 0) {
    parts.push(`request=${requestSummary}`);
  }
  if (renderedOutput.length > 0) {
    parts.push(`output=${JSON.stringify(renderedOutput)}`);
  }

  return parts.join(" | ");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return normalizeText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return normalizeText(
    content
      .map((entry) => {
        const record = asRecord(entry);
        return typeof record?.text === "string" ? record.text : "";
      })
      .filter((entry) => entry.length > 0)
      .join("\n"),
  );
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncateText(input: string, maxChars: number): string {
  if (maxChars <= 0 || input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}...[truncated]`;
}

function parseJson<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
