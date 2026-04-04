import { and, asc, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { conversations } from "@/src/storage/schema/tables.js";
import type { Conversation, NewConversation } from "@/src/storage/schema/types.js";

export interface CreateConversationInput {
  id: string;
  channelInstanceId: string;
  externalChatId: string;
  kind: string;
  title?: string | null;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ConversationsRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateConversationInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewConversation = {
      id: input.id,
      channelInstanceId: input.channelInstanceId,
      externalChatId: input.externalChatId,
      kind: input.kind,
      title: input.title ?? null,
      status: input.status ?? "active",
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(conversations).values(row).run();
  }

  getById(id: string): Conversation | null {
    return this.db.select().from(conversations).where(eq(conversations.id, id)).get() ?? null;
  }

  findByChannelInstanceAndExternalChat(
    channelInstanceId: string,
    externalChatId: string,
  ): Conversation | null {
    return (
      this.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channelInstanceId, channelInstanceId),
            eq(conversations.externalChatId, externalChatId),
          ),
        )
        .get() ?? null
    );
  }

  listByChannelInstanceId(channelInstanceId: string, limit: number = 20): Conversation[] {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.channelInstanceId, channelInstanceId))
      .orderBy(asc(conversations.createdAt), asc(conversations.id))
      .limit(limit)
      .all();
  }
}
