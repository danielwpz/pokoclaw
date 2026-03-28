import { and, asc, desc, eq, gt } from "drizzle-orm";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { messages } from "@/src/storage/schema/tables.js";
import type { Message, NewMessage } from "@/src/storage/schema/types.js";

export interface MessageUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: MessageUsageCost;
}

export interface AppendMessageInput {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  payloadJson: string;
  createdAt?: Date;
  messageType?: string;
  visibility?: string;
  channelMessageId?: string | null;
  provider?: string | null;
  model?: string | null;
  modelApi?: string | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  tokenCacheRead?: number | null;
  tokenCacheWrite?: number | null;
  tokenTotal?: number | null;
  usage?: MessageUsage | null;
}

export interface ListSessionMessagesOptions {
  afterSeq?: number;
  limit?: number;
}

export class MessagesRepo {
  constructor(private readonly db: StorageDb) {}

  append(input: AppendMessageInput): void {
    const usage = input.usage != null ? normalizeMessageUsage(input.usage) : null;
    const row: NewMessage = {
      id: input.id,
      sessionId: input.sessionId,
      seq: input.seq,
      role: input.role,
      messageType: input.messageType ?? "text",
      visibility: input.visibility ?? "user_visible",
      channelMessageId: input.channelMessageId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      modelApi: input.modelApi ?? null,
      stopReason: input.stopReason ?? null,
      errorMessage: input.errorMessage ?? null,
      payloadJson: input.payloadJson,
      tokenInput: input.tokenInput ?? usage?.input ?? null,
      tokenOutput: input.tokenOutput ?? usage?.output ?? null,
      tokenCacheRead: input.tokenCacheRead ?? usage?.cacheRead ?? null,
      tokenCacheWrite: input.tokenCacheWrite ?? usage?.cacheWrite ?? null,
      tokenTotal: input.tokenTotal ?? usage?.totalTokens ?? null,
      usageJson: usage == null ? null : JSON.stringify(usage),
      createdAt: toCanonicalUtcIsoTimestamp(input.createdAt ?? new Date()),
    };

    this.db.insert(messages).values(row).run();
  }

  listBySession(sessionId: string, options: ListSessionMessagesOptions = {}): Message[] {
    const afterSeq = options.afterSeq ?? 0;
    const query = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, afterSeq)))
      .orderBy(asc(messages.seq));

    if (options.limit != null) {
      return query.limit(options.limit).all();
    }

    return query.all();
  }

  getLatestAssistantBySession(sessionId: string): Message | null {
    return (
      this.db
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant")))
        .orderBy(desc(messages.seq))
        .get() ?? null
    );
  }

  getNextSeq(sessionId: string): number {
    const rows = this.db
      .select({ seq: messages.seq })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq))
      .all();

    const lastSeq = rows.at(-1)?.seq ?? 0;
    return lastSeq + 1;
  }
}

function normalizeMessageUsage(usage: MessageUsage): MessageUsage {
  const normalized: MessageUsage = {
    input: normalizeUsageInt("usage.input", usage.input),
    output: normalizeUsageInt("usage.output", usage.output),
    cacheRead: normalizeUsageInt("usage.cacheRead", usage.cacheRead),
    cacheWrite: normalizeUsageInt("usage.cacheWrite", usage.cacheWrite),
    totalTokens: normalizeUsageInt("usage.totalTokens", usage.totalTokens),
  };

  if (usage.cost != null) {
    normalized.cost = {
      input: normalizeUsageNumber("usage.cost.input", usage.cost.input),
      output: normalizeUsageNumber("usage.cost.output", usage.cost.output),
      cacheRead: normalizeUsageNumber("usage.cost.cacheRead", usage.cost.cacheRead),
      cacheWrite: normalizeUsageNumber("usage.cost.cacheWrite", usage.cost.cacheWrite),
      total: normalizeUsageNumber("usage.cost.total", usage.cost.total),
    };
  }

  return normalized;
}

function normalizeUsageInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
}

function normalizeUsageNumber(field: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }

  return value;
}
