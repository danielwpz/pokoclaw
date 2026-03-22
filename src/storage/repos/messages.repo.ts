import { and, asc, eq, gt } from "drizzle-orm";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { messages } from "@/src/storage/schema/tables.js";
import type { Message, NewMessage } from "@/src/storage/schema/types.js";

export interface AppendMessageInput {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  contentJson: string;
  createdAt?: Date;
  messageType?: string;
  visibility?: string;
  channelMessageId?: string | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
}

export interface ListSessionMessagesOptions {
  afterSeq?: number;
  limit?: number;
}

export class MessagesRepo {
  constructor(
    private readonly db: StorageDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(input: AppendMessageInput): void {
    const row: NewMessage = {
      id: input.id,
      sessionId: input.sessionId,
      seq: input.seq,
      role: input.role,
      messageType: input.messageType ?? "text",
      visibility: input.visibility ?? "user_visible",
      channelMessageId: input.channelMessageId ?? null,
      contentJson: input.contentJson,
      tokenInput: input.tokenInput ?? null,
      tokenOutput: input.tokenOutput ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(input.createdAt ?? this.now()),
    };

    this.db.insert(messages).values(row).run();
  }

  listBySession(sessionId: string, options: ListSessionMessagesOptions = {}): Message[] {
    const limit = options.limit ?? 500;
    const afterSeq = options.afterSeq ?? 0;

    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, afterSeq)))
      .orderBy(asc(messages.seq))
      .limit(limit)
      .all();
  }
}
