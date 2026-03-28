import { and, eq } from "drizzle-orm";

import { createSubsystemLogger } from "@/src/shared/logger.js";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { channelSurfaces } from "@/src/storage/schema/tables.js";
import type { ChannelSurface, NewChannelSurface } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("storage/channel-surfaces");

export interface UpsertChannelSurfaceInput {
  id: string;
  channelType: string;
  channelInstallationId: string;
  conversationId: string;
  branchId: string;
  surfaceKey: string;
  surfaceObjectJson: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ChannelSurfacesRepo {
  constructor(private readonly db: StorageDb) {}

  upsert(input: UpsertChannelSurfaceInput): ChannelSurface {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewChannelSurface = {
      id: input.id,
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      surfaceKey: input.surfaceKey,
      surfaceObjectJson: input.surfaceObjectJson,
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    logger.debug("upserting channel surface", {
      id: input.id,
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      surfaceKey: input.surfaceKey,
    });

    this.db
      .insert(channelSurfaces)
      .values(row)
      .onConflictDoUpdate({
        target: [
          channelSurfaces.channelType,
          channelSurfaces.channelInstallationId,
          channelSurfaces.conversationId,
          channelSurfaces.branchId,
        ],
        set: {
          surfaceKey: row.surfaceKey,
          surfaceObjectJson: row.surfaceObjectJson,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    const surface = this.getByConversationBranch({
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      conversationId: input.conversationId,
      branchId: input.branchId,
    });
    if (surface == null) {
      throw new Error(`Channel surface ${input.id} disappeared after upsert`);
    }

    logger.info("channel surface upserted", {
      channelType: surface.channelType,
      channelInstallationId: surface.channelInstallationId,
      conversationId: surface.conversationId,
      branchId: surface.branchId,
      surfaceKey: surface.surfaceKey,
    });
    return surface;
  }

  getByConversationBranch(input: {
    channelType: string;
    channelInstallationId: string;
    conversationId: string;
    branchId: string;
  }): ChannelSurface | null {
    return (
      this.db
        .select()
        .from(channelSurfaces)
        .where(
          and(
            eq(channelSurfaces.channelType, input.channelType),
            eq(channelSurfaces.channelInstallationId, input.channelInstallationId),
            eq(channelSurfaces.conversationId, input.conversationId),
            eq(channelSurfaces.branchId, input.branchId),
          ),
        )
        .get() ?? null
    );
  }

  getBySurfaceKey(input: {
    channelType: string;
    channelInstallationId: string;
    surfaceKey: string;
  }): ChannelSurface | null {
    const surface =
      this.db
        .select()
        .from(channelSurfaces)
        .where(
          and(
            eq(channelSurfaces.channelType, input.channelType),
            eq(channelSurfaces.channelInstallationId, input.channelInstallationId),
            eq(channelSurfaces.surfaceKey, input.surfaceKey),
          ),
        )
        .get() ?? null;

    logger.debug("resolved channel surface by key", {
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      surfaceKey: input.surfaceKey,
      found: surface != null,
      conversationId: surface?.conversationId,
      branchId: surface?.branchId,
    });

    return surface;
  }
}
