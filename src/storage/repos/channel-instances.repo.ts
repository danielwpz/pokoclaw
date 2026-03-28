import { and, eq } from "drizzle-orm";

import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { channelInstances } from "@/src/storage/schema/tables.js";
import type { ChannelInstance, NewChannelInstance } from "@/src/storage/schema/types.js";

export interface CreateChannelInstanceInput {
  id: string;
  provider: string;
  accountKey: string;
  displayName?: string | null;
  status?: string;
  configRef?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ChannelInstancesRepo {
  constructor(private readonly db: StorageDb) {}

  create(input: CreateChannelInstanceInput): void {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewChannelInstance = {
      id: input.id,
      provider: input.provider,
      accountKey: input.accountKey,
      displayName: input.displayName ?? null,
      status: input.status ?? "active",
      configRef: input.configRef ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    this.db.insert(channelInstances).values(row).run();
  }

  getByProviderAndAccountKey(provider: string, accountKey: string): ChannelInstance | null {
    return (
      this.db
        .select()
        .from(channelInstances)
        .where(
          and(eq(channelInstances.provider, provider), eq(channelInstances.accountKey, accountKey)),
        )
        .get() ?? null
    );
  }
}
