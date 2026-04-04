import { and, eq, like } from "drizzle-orm";

import { createSubsystemLogger } from "@/src/shared/logger.js";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { larkObjectBindings } from "@/src/storage/schema/tables.js";
import type { LarkObjectBinding, NewLarkObjectBinding } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("storage/lark-object-bindings");

export interface UpsertLarkObjectBindingInput {
  id: string;
  channelInstallationId: string;
  conversationId: string;
  branchId: string;
  internalObjectKind: string;
  internalObjectId: string;
  larkMessageId?: string | null;
  larkOpenMessageId?: string | null;
  larkCardId?: string | null;
  threadRootMessageId?: string | null;
  cardElementId?: string | null;
  lastSequence?: number | null;
  status?: "active" | "finalized" | "stale";
  metadataJson?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class LarkObjectBindingsRepo {
  constructor(private readonly db: StorageDb) {}

  upsert(input: UpsertLarkObjectBindingInput): LarkObjectBinding {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewLarkObjectBinding = {
      id: input.id,
      channelInstallationId: input.channelInstallationId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      internalObjectKind: input.internalObjectKind,
      internalObjectId: input.internalObjectId,
      larkMessageId: input.larkMessageId ?? null,
      larkOpenMessageId: input.larkOpenMessageId ?? null,
      larkCardId: input.larkCardId ?? null,
      threadRootMessageId: input.threadRootMessageId ?? null,
      cardElementId: input.cardElementId ?? null,
      lastSequence: input.lastSequence ?? null,
      status: input.status ?? "active",
      metadataJson: input.metadataJson ?? null,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    logger.debug("upserting lark object binding", {
      id: input.id,
      channelInstallationId: input.channelInstallationId,
      internalObjectKind: input.internalObjectKind,
      internalObjectId: input.internalObjectId,
      larkMessageId: input.larkMessageId,
      larkCardId: input.larkCardId,
    });

    this.db
      .insert(larkObjectBindings)
      .values(row)
      .onConflictDoUpdate({
        target: [
          larkObjectBindings.channelInstallationId,
          larkObjectBindings.internalObjectKind,
          larkObjectBindings.internalObjectId,
        ],
        set: {
          conversationId: row.conversationId,
          branchId: row.branchId,
          larkMessageId: row.larkMessageId,
          larkOpenMessageId: row.larkOpenMessageId,
          larkCardId: row.larkCardId,
          threadRootMessageId: row.threadRootMessageId,
          cardElementId: row.cardElementId,
          lastSequence: row.lastSequence,
          status: row.status,
          metadataJson: row.metadataJson,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    const binding = this.getByInternalObject({
      channelInstallationId: input.channelInstallationId,
      internalObjectKind: input.internalObjectKind,
      internalObjectId: input.internalObjectId,
    });
    if (binding == null) {
      throw new Error(`Lark object binding ${input.id} disappeared after upsert`);
    }

    logger.info("lark object binding upserted", {
      channelInstallationId: binding.channelInstallationId,
      internalObjectKind: binding.internalObjectKind,
      internalObjectId: binding.internalObjectId,
      larkMessageId: binding.larkMessageId,
      larkCardId: binding.larkCardId,
      status: binding.status,
    });

    return binding;
  }

  getByInternalObject(input: {
    channelInstallationId: string;
    internalObjectKind: string;
    internalObjectId: string;
  }): LarkObjectBinding | null {
    return (
      this.db
        .select()
        .from(larkObjectBindings)
        .where(
          and(
            eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
            eq(larkObjectBindings.internalObjectKind, input.internalObjectKind),
            eq(larkObjectBindings.internalObjectId, input.internalObjectId),
          ),
        )
        .get() ?? null
    );
  }

  getByLarkMessageId(input: {
    channelInstallationId: string;
    larkMessageId: string;
  }): LarkObjectBinding | null {
    const binding =
      this.db
        .select()
        .from(larkObjectBindings)
        .where(
          and(
            eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
            eq(larkObjectBindings.larkMessageId, input.larkMessageId),
          ),
        )
        .get() ?? null;

    logger.debug("resolved lark binding by message id", {
      channelInstallationId: input.channelInstallationId,
      larkMessageId: input.larkMessageId,
      found: binding != null,
      internalObjectKind: binding?.internalObjectKind,
      internalObjectId: binding?.internalObjectId,
    });

    return binding;
  }

  getByLarkCardId(input: {
    channelInstallationId: string;
    larkCardId: string;
  }): LarkObjectBinding | null {
    const binding =
      this.db
        .select()
        .from(larkObjectBindings)
        .where(
          and(
            eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
            eq(larkObjectBindings.larkCardId, input.larkCardId),
          ),
        )
        .get() ?? null;

    logger.debug("resolved lark binding by card id", {
      channelInstallationId: input.channelInstallationId,
      larkCardId: input.larkCardId,
      found: binding != null,
      internalObjectKind: binding?.internalObjectKind,
      internalObjectId: binding?.internalObjectId,
    });

    return binding;
  }

  getByThreadRootMessageId(input: {
    channelInstallationId: string;
    threadRootMessageId: string;
  }): LarkObjectBinding | null {
    const binding =
      this.db
        .select()
        .from(larkObjectBindings)
        .where(
          and(
            eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
            eq(larkObjectBindings.threadRootMessageId, input.threadRootMessageId),
          ),
        )
        .get() ?? null;

    logger.debug("resolved lark binding by thread root message id", {
      channelInstallationId: input.channelInstallationId,
      threadRootMessageId: input.threadRootMessageId,
      found: binding != null,
      internalObjectKind: binding?.internalObjectKind,
      internalObjectId: binding?.internalObjectId,
    });

    return binding;
  }

  updateDeliveryState(input: {
    channelInstallationId: string;
    internalObjectKind: string;
    internalObjectId: string;
    lastSequence?: number | null;
    status?: "active" | "finalized" | "stale";
    metadataJson?: string | null;
    updatedAt?: Date;
  }): LarkObjectBinding | null {
    const updatedAt = input.updatedAt ?? new Date();
    const result = this.db
      .update(larkObjectBindings)
      .set({
        ...(input.lastSequence === undefined ? {} : { lastSequence: input.lastSequence ?? null }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.metadataJson === undefined ? {} : { metadataJson: input.metadataJson ?? null }),
        updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
      })
      .where(
        and(
          eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
          eq(larkObjectBindings.internalObjectKind, input.internalObjectKind),
          eq(larkObjectBindings.internalObjectId, input.internalObjectId),
        ),
      )
      .run();

    if ((result.changes ?? 0) < 1) {
      return null;
    }

    logger.debug("updated lark delivery state", {
      channelInstallationId: input.channelInstallationId,
      internalObjectKind: input.internalObjectKind,
      internalObjectId: input.internalObjectId,
      lastSequence: input.lastSequence,
      status: input.status,
    });

    return this.getByInternalObject({
      channelInstallationId: input.channelInstallationId,
      internalObjectKind: input.internalObjectKind,
      internalObjectId: input.internalObjectId,
    });
  }

  deleteByInternalObject(input: {
    channelInstallationId: string;
    internalObjectKind: string;
    internalObjectId: string;
  }): boolean {
    const result = this.db
      .delete(larkObjectBindings)
      .where(
        and(
          eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
          eq(larkObjectBindings.internalObjectKind, input.internalObjectKind),
          eq(larkObjectBindings.internalObjectId, input.internalObjectId),
        ),
      )
      .run();

    const deleted = (result.changes ?? 0) > 0;
    logger.debug("deleted lark object binding", {
      channelInstallationId: input.channelInstallationId,
      internalObjectKind: input.internalObjectKind,
      internalObjectId: input.internalObjectId,
      deleted,
    });
    return deleted;
  }

  listByInternalObjectPrefix(input: {
    channelInstallationId: string;
    internalObjectKind: string;
    internalObjectIdPrefix: string;
  }): LarkObjectBinding[] {
    const prefix = input.internalObjectIdPrefix;
    return this.db
      .select()
      .from(larkObjectBindings)
      .where(
        and(
          eq(larkObjectBindings.channelInstallationId, input.channelInstallationId),
          eq(larkObjectBindings.internalObjectKind, input.internalObjectKind),
          like(larkObjectBindings.internalObjectId, `${prefix}%`),
        ),
      )
      .all()
      .filter(
        (binding) =>
          binding.internalObjectId === prefix ||
          binding.internalObjectId.startsWith(`${prefix}:page:`),
      );
  }
}
