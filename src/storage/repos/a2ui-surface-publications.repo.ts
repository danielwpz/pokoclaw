import { and, eq } from "drizzle-orm";

import { createSubsystemLogger } from "@/src/shared/logger.js";
import { toCanonicalUtcIsoTimestamp } from "@/src/shared/time.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { a2uiSurfacePublications } from "@/src/storage/schema/tables.js";
import type {
  A2uiSurfacePublication,
  NewA2uiSurfacePublication,
} from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("storage/a2ui-publications");

export type A2uiSurfacePublicationStatus = "active" | "stale";

export interface UpsertA2uiSurfacePublicationInput {
  id: string;
  surfaceId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  channelType: string;
  channelInstallationId: string;
  channelArtifactId: string;
  channelMessageId?: string | null | undefined;
  channelSequence?: number | undefined;
  surfaceStateJson: string;
  consumedActionKeysJson?: string | undefined;
  status?: A2uiSurfacePublicationStatus | undefined;
  createdAt?: Date | undefined;
  updatedAt?: Date | undefined;
}

export interface PatchA2uiSurfacePublicationInput {
  id: string;
  channelSequence?: number | undefined;
  surfaceStateJson?: string | undefined;
  consumedActionKeysJson?: string | undefined;
  status?: A2uiSurfacePublicationStatus | undefined;
  updatedAt?: Date | undefined;
}

export type ConsumeA2uiSurfacePublicationActionResult =
  | {
      status: "consumed";
      publication: A2uiSurfacePublication;
    }
  | {
      status: "duplicate";
      publication: A2uiSurfacePublication;
    }
  | {
      status: "missing";
    };

export interface ConsumeA2uiSurfacePublicationActionInput {
  id: string;
  actionKey: string;
  surfaceStateJson: string;
  updatedAt?: Date | undefined;
}

const MAX_CONSUME_ACTION_CAS_RETRIES = 5;

export class A2uiSurfacePublicationsRepo {
  constructor(private readonly db: StorageDb) {}

  upsert(input: UpsertA2uiSurfacePublicationInput): A2uiSurfacePublication {
    const createdAt = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? createdAt;
    const row: NewA2uiSurfacePublication = {
      id: input.id,
      surfaceId: input.surfaceId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      channelType: input.channelType,
      channelInstallationId: input.channelInstallationId,
      channelArtifactId: input.channelArtifactId,
      channelMessageId: input.channelMessageId ?? null,
      channelSequence: input.channelSequence ?? 1,
      surfaceStateJson: input.surfaceStateJson,
      consumedActionKeysJson: input.consumedActionKeysJson ?? "[]",
      status: input.status ?? "active",
      createdAt: toCanonicalUtcIsoTimestamp(createdAt),
      updatedAt: toCanonicalUtcIsoTimestamp(updatedAt),
    };

    logger.debug("upserting a2ui surface publication", {
      surfaceId: row.surfaceId,
      sessionId: row.sessionId,
      conversationId: row.conversationId,
      branchId: row.branchId,
      channelType: row.channelType,
      channelInstallationId: row.channelInstallationId,
      channelArtifactId: row.channelArtifactId,
      channelSequence: row.channelSequence,
      status: row.status,
    });

    this.db
      .insert(a2uiSurfacePublications)
      .values(row)
      .onConflictDoUpdate({
        target: a2uiSurfacePublications.id,
        set: {
          sessionId: row.sessionId,
          conversationId: row.conversationId,
          branchId: row.branchId,
          channelArtifactId: row.channelArtifactId,
          channelMessageId: row.channelMessageId,
          channelSequence: row.channelSequence,
          surfaceStateJson: row.surfaceStateJson,
          consumedActionKeysJson: row.consumedActionKeysJson,
          status: row.status,
          updatedAt: row.updatedAt,
        },
      })
      .run();

    const publication = this.getById(input.id);
    if (publication == null) {
      throw new Error(`A2UI surface publication ${input.id} disappeared after upsert`);
    }

    logger.info("a2ui surface publication upserted", {
      id: publication.id,
      surfaceId: publication.surfaceId,
      sessionId: publication.sessionId,
      conversationId: publication.conversationId,
      branchId: publication.branchId,
      channelType: publication.channelType,
      channelInstallationId: publication.channelInstallationId,
      channelArtifactId: publication.channelArtifactId,
      channelSequence: publication.channelSequence,
      status: publication.status,
    });

    return publication;
  }

  getById(id: string): A2uiSurfacePublication | null {
    return (
      this.db
        .select()
        .from(a2uiSurfacePublications)
        .where(eq(a2uiSurfacePublications.id, id))
        .get() ?? null
    );
  }

  consumeAction(
    input: ConsumeA2uiSurfacePublicationActionInput,
  ): ConsumeA2uiSurfacePublicationActionResult {
    for (let attempt = 0; attempt < MAX_CONSUME_ACTION_CAS_RETRIES; attempt += 1) {
      const current = this.getById(input.id);
      if (current?.status !== "active") {
        return { status: "missing" };
      }

      const consumedActionKeys = parseConsumedActionKeysJson(current.consumedActionKeysJson);
      if (consumedActionKeys.has(input.actionKey)) {
        return {
          status: "duplicate",
          publication: current,
        };
      }

      consumedActionKeys.add(input.actionKey);
      const nextConsumedActionKeysJson = serializeConsumedActionKeysJson(consumedActionKeys);
      const updatedAt = toCanonicalUtcIsoTimestamp(input.updatedAt ?? new Date());
      const result = this.db
        .update(a2uiSurfacePublications)
        .set({
          surfaceStateJson: input.surfaceStateJson,
          consumedActionKeysJson: nextConsumedActionKeysJson,
          updatedAt,
        })
        .where(
          and(
            eq(a2uiSurfacePublications.id, input.id),
            eq(a2uiSurfacePublications.status, "active"),
            eq(a2uiSurfacePublications.consumedActionKeysJson, current.consumedActionKeysJson),
          ),
        )
        .run();

      if ((result.changes ?? 0) > 0) {
        const publication = this.getById(input.id);
        if (publication == null) {
          return { status: "missing" };
        }
        return {
          status: "consumed",
          publication,
        };
      }
    }

    throw new Error(`Failed to consume A2UI action '${input.actionKey}' after CAS retries.`);
  }

  patch(input: PatchA2uiSurfacePublicationInput): A2uiSurfacePublication | null {
    const updatedAt = toCanonicalUtcIsoTimestamp(input.updatedAt ?? new Date());
    this.db
      .update(a2uiSurfacePublications)
      .set({
        ...(input.channelSequence === undefined ? {} : { channelSequence: input.channelSequence }),
        ...(input.surfaceStateJson === undefined
          ? {}
          : { surfaceStateJson: input.surfaceStateJson }),
        ...(input.consumedActionKeysJson === undefined
          ? {}
          : { consumedActionKeysJson: input.consumedActionKeysJson }),
        ...(input.status === undefined ? {} : { status: input.status }),
        updatedAt,
      })
      .where(eq(a2uiSurfacePublications.id, input.id))
      .run();

    return this.getById(input.id);
  }

  markStale(id: string, updatedAt: Date = new Date()): A2uiSurfacePublication | null {
    return this.patch({
      id,
      status: "stale",
      updatedAt,
    });
  }
}

function parseConsumedActionKeysJson(value: string): Set<string> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Stored A2UI consumed action keys are invalid.");
  }
  return new Set(parsed);
}

function serializeConsumedActionKeysJson(value: Set<string>): string {
  return JSON.stringify(Array.from(value).sort());
}
