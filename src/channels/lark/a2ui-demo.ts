import { randomUUID } from "node:crypto";
import {
  type A2uiRuntimeMessage,
  type Disposable,
  DynamicDataRuntime,
  extractLarkCallback,
  formatValidationIssues,
  isDataSourceUpdateMessage,
  type NormalizedCallbackInput,
  normalizeCallback,
  renderSurface,
  type SurfaceState,
  SurfaceStore,
  validateA2uiMessages,
} from "lark-a2ui-renderer/v0_8";

import {
  invokeLarkCardkitCallWithBusinessRetry,
  invokeSequencedLarkCardkitMutation,
  type LarkCardCreateResponse,
  type LarkCardOperationResponse,
} from "@/src/channels/lark/cardkit-mutations.js";
import type { LarkSdkClient } from "@/src/channels/lark/client.js";
import { listLarkDeliveryTargets, readStringValue } from "@/src/channels/lark/delivery-targets.js";
import type { LarkInboundIngress } from "@/src/channels/lark/inbound.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";

const logger = createSubsystemLogger("channels/lark-a2ui-demo");
const DEFAULT_DYNAMIC_TTL_MS = 60_000;
const MAX_DYNAMIC_TTL_MS = 5 * 60_000;

export interface A2uiPublishInput {
  sessionId: string;
  conversationId: string;
  messages: unknown;
  ttlMs?: number;
}

export interface A2uiPublishResult {
  surfaceId: string;
  cardId: string;
  messageId?: string;
  sequence: number;
  dynamic: boolean;
  expiresAt?: string;
  warnings: string[];
}

interface A2uiSurfacePublication {
  surfaceId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  channelInstallationId: string;
  cardId: string;
  messageId?: string;
  sequence: number;
  store: SurfaceStore;
  dynamicRuntime?: DynamicDataRuntime;
  dynamicDisposer?: Disposable;
  expiryTimer?: NodeJS.Timeout;
  expiresAt?: Date;
  updateChain?: Promise<void>;
  updateCount?: number;
  consumedActionKeys: Set<string>;
}

export class LarkA2uiDemoService {
  private readonly publications = new Map<string, A2uiSurfacePublication>();

  constructor(
    private readonly deps: {
      storage: StorageDb;
      clients: {
        getOrCreate(installationId: string): LarkSdkClient;
      };
      ingress: LarkInboundIngress;
    },
  ) {}

  async publish(input: A2uiPublishInput): Promise<A2uiPublishResult> {
    const validation = validateA2uiMessages(input.messages, {
      allowDynamicDataSources: true,
    });
    if (!validation.ok) {
      throw new Error(`Invalid A2UI messages:\n${formatValidationIssues(validation.issues)}`);
    }

    const messages = normalizeMessages(input.messages);
    const store = new SurfaceStore();
    const dynamicSourceRefs = listDynamicSourceRefs(messages);
    const hasDynamicSources = dynamicSourceRefs.length > 0;
    const dynamicRuntime = new DynamicDataRuntime(store, {
      onDataModelChange: async (event) => {
        await this.enqueueSurfaceUpdate(event.surfaceId);
      },
      log: (level, message) => logDynamicDataRuntime(level, message),
    });
    dynamicRuntime.applyMessages(messages);

    const surfaceId = chooseSurfaceId(validation.renderedSurfaceIds, store);
    if (hasDynamicSources) {
      for (const source of dynamicSourceRefs.filter((source) => source.surfaceId === surfaceId)) {
        const event = await dynamicRuntime.runSourceOnce(source.surfaceId, source.sourceId);
        logger.info("primed a2ui dynamic data source", {
          surfaceId: source.surfaceId,
          sourceId: source.sourceId,
          targetPath: event.path,
          valueSummary: summarizeValue(event.value),
        });
      }
    }
    const surface = store.getSurface(surfaceId);
    const rendered = renderSurface(surface);
    logger.info("rendered a2ui demo surface before publish", {
      surfaceId,
      dynamic: hasDynamicSources,
      renderSummary: summarizeRenderedSurface(surface, rendered.card),
      warnings: rendered.warnings.map((warning) => warning.message),
    });
    const session = new SessionsRepo(this.deps.storage).getById(input.sessionId);
    if (session == null) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }

    const target = listLarkDeliveryTargets(this.deps.storage, {
      conversationId: input.conversationId,
      branchId: session.branchId,
    })[0];
    if (target == null) {
      throw new Error("No Lark delivery target is paired for this conversation.");
    }

    const chatId = readStringValue(target.surfaceObject.chat_id);
    if (chatId == null) {
      throw new Error("The paired Lark delivery target does not include chat_id.");
    }

    const client = this.deps.clients.getOrCreate(target.channelInstallationId);
    const cardkit = getCardkitSdk(client);
    const createResp = await invokeLarkCardkitCallWithBusinessRetry({
      logger,
      operation: "card.create",
      logContext: {
        surfaceId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        channelInstallationId: target.channelInstallationId,
      },
      invoke: () =>
        cardkit.card.create({
          data: {
            type: "card_json",
            data: JSON.stringify(rendered.card),
          },
        }),
    });
    const cardId = createResp.data?.card_id ?? createResp.card_id ?? null;
    if (cardId == null) {
      throw new Error("Lark CardKit create did not return card_id.");
    }

    const messageResp = await sendLarkInteractiveCardReferenceMessage({
      client,
      chatId,
      surfaceObject: target.surfaceObject,
      cardId,
    });
    const messageId = messageResp.data?.message_id ?? undefined;
    const ttlMs = clampTtlMs(input.ttlMs);
    const expiresAt = hasDynamicSources ? new Date(Date.now() + ttlMs) : undefined;

    const publication: A2uiSurfacePublication = {
      surfaceId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: session.branchId,
      channelInstallationId: target.channelInstallationId,
      cardId,
      ...(messageId === undefined ? {} : { messageId }),
      sequence: 1,
      updateCount: 0,
      consumedActionKeys: new Set(),
      store,
      ...(hasDynamicSources ? { dynamicRuntime } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    this.publications.set(surfaceId, publication);

    if (hasDynamicSources) {
      publication.dynamicDisposer = dynamicRuntime.start(surfaceId);
      publication.expiryTimer = setTimeout(() => {
        this.disposeSurface(surfaceId, "ttl_expired");
      }, ttlMs);
    }

    logger.info("published a2ui demo surface", {
      surfaceId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: session.branchId,
      channelInstallationId: target.channelInstallationId,
      cardId,
      messageId: messageId ?? null,
      dynamic: hasDynamicSources,
      expiresAt: expiresAt?.toISOString() ?? null,
      renderSummary: summarizeRenderedSurface(surface, rendered.card),
    });

    return {
      surfaceId,
      cardId,
      ...(messageId === undefined ? {} : { messageId }),
      sequence: publication.sequence,
      dynamic: hasDynamicSources,
      ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
      warnings: rendered.warnings.map((warning) => warning.message),
    };
  }

  async handleCardAction(input: {
    installationId: string;
    payload: unknown;
  }): Promise<unknown | null> {
    let callback: NormalizedCallbackInput;
    try {
      callback = extractLarkCallback(input.payload);
    } catch {
      return null;
    }

    const publication = this.publications.get(callback.envelope.surfaceId);
    if (publication == null) {
      return {
        toast: {
          type: "error",
          content: "A2UI demo state 已过期，请重新发送卡片。",
        },
      };
    }
    if (publication.channelInstallationId !== input.installationId) {
      return {
        toast: {
          type: "error",
          content: "A2UI callback installation 不匹配。",
        },
      };
    }

    let event: ReturnType<typeof normalizeCallback>;
    try {
      event = normalizeCallback(
        publication.store.getSurface(callback.envelope.surfaceId),
        callback,
      );
    } catch (error) {
      logger.warn("failed to normalize a2ui callback", {
        surfaceId: callback.envelope.surfaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        toast: {
          type: "error",
          content: error instanceof Error ? error.message : "A2UI callback 处理失败",
        },
      };
    }

    const actionKey = buildConsumedActionKey(
      event.userAction.sourceComponentId,
      event.userAction.name,
    );
    if (publication.consumedActionKeys.has(actionKey)) {
      logger.info("ignored duplicate a2ui callback for consumed action", {
        surfaceId: publication.surfaceId,
        sessionId: publication.sessionId,
        sourceComponentId: event.userAction.sourceComponentId,
        actionName: event.userAction.name,
      });
      return {
        toast: {
          type: "success",
          content: "已收到",
        },
      };
    }

    publication.consumedActionKeys.add(actionKey);
    void this.enqueueSurfaceUpdate(publication.surfaceId).catch((error: unknown) => {
      logger.warn("failed to update a2ui card after consuming action", {
        surfaceId: publication.surfaceId,
        sourceComponentId: event.userAction.sourceComponentId,
        actionName: event.userAction.name,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    void this.deps.ingress
      .submitMessage({
        sessionId: publication.sessionId,
        scenario: "chat",
        content: `A2UI user action:\n${JSON.stringify(event, null, 2)}`,
        messageType: "a2ui_user_action",
        channelMessageId: `a2ui:${publication.surfaceId}:${randomUUID()}`,
        createdAt: new Date(),
        maxTurns: 6,
      })
      .catch((error: unknown) => {
        logger.warn("failed to submit a2ui callback to runtime ingress", {
          surfaceId: callback.envelope.surfaceId,
          sessionId: publication.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    logger.info("accepted a2ui callback for asynchronous runtime submission", {
      surfaceId: publication.surfaceId,
      sessionId: publication.sessionId,
      actionName: event.userAction.name,
    });

    return {
      toast: {
        type: "success",
        content: "已收到",
      },
    };
  }

  shutdown(): void {
    for (const surfaceId of this.publications.keys()) {
      this.disposeSurface(surfaceId, "shutdown");
    }
  }

  private async enqueueSurfaceUpdate(surfaceId: string): Promise<void> {
    const publication = this.publications.get(surfaceId);
    if (publication == null) {
      return;
    }

    const previous = publication.updateChain ?? Promise.resolve();
    const next = previous
      .catch((error: unknown) => {
        logger.warn("previous a2ui surface update failed before queued update", {
          surfaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => this.updateSurfaceNow(surfaceId));
    publication.updateChain = next.catch(() => {});
    await next;
  }

  private async updateSurfaceNow(surfaceId: string): Promise<void> {
    const publication = this.publications.get(surfaceId);
    if (publication == null) {
      return;
    }

    const client = this.deps.clients.getOrCreate(publication.channelInstallationId);
    const cardkit = getCardkitSdk(client);
    const surface = publication.store.getSurface(surfaceId);
    const rendered = renderSurface(surface);
    applyConsumedActionTransforms(rendered.card, publication.consumedActionKeys);
    const sequence = publication.sequence + 1;
    const nextUpdateCount = (publication.updateCount ?? 0) + 1;
    if (shouldLogUpdate(nextUpdateCount)) {
      logger.info("updating a2ui demo surface", {
        surfaceId,
        updateCount: nextUpdateCount,
        currentSequence: publication.sequence,
        nextSequence: sequence,
        renderSummary: summarizeRenderedSurface(surface, rendered.card),
      });
    }
    const outcome = await invokeSequencedLarkCardkitMutation({
      logger,
      operation: "card.update",
      logContext: {
        surfaceId,
        channelInstallationId: publication.channelInstallationId,
        cardId: publication.cardId,
      },
      sequence,
      invoke: () =>
        cardkit.card.update({
          path: {
            card_id: publication.cardId,
          },
          data: {
            card: {
              type: "card_json",
              data: JSON.stringify(rendered.card),
            },
            sequence,
          },
        }),
    });

    if (outcome.kind === "applied") {
      publication.sequence = sequence;
      publication.updateCount = nextUpdateCount;
      if (shouldLogUpdate(nextUpdateCount)) {
        logger.info("updated a2ui demo surface", {
          surfaceId,
          updateCount: nextUpdateCount,
          channelInstallationId: publication.channelInstallationId,
          cardId: publication.cardId,
          sequence,
        });
      }
      logger.debug("updated a2ui demo surface debug", {
        surfaceId,
        channelInstallationId: publication.channelInstallationId,
        cardId: publication.cardId,
        sequence,
      });
      return;
    }

    publication.sequence = Math.max(publication.sequence, outcome.nextSequenceFloor - 1);
    publication.updateCount = nextUpdateCount;
    logger.warn("a2ui demo surface update needs sequence reconcile", {
      surfaceId,
      updateCount: nextUpdateCount,
      nextSequenceFloor: outcome.nextSequenceFloor,
      sequenceAfterReconcile: publication.sequence,
      reason: outcome.reason,
    });
  }

  private disposeSurface(surfaceId: string, reason: string): void {
    const publication = this.publications.get(surfaceId);
    if (publication == null) {
      return;
    }
    publication.dynamicDisposer?.dispose();
    if (publication.expiryTimer != null) {
      clearTimeout(publication.expiryTimer);
    }
    publication.dynamicRuntime?.stopAll();
    this.publications.delete(surfaceId);
    logger.info("disposed a2ui demo surface", { surfaceId, reason });
  }
}

function normalizeMessages(value: unknown): A2uiRuntimeMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("publish_a2ui.messages must be an array of A2UI runtime messages.");
  }
  return value as A2uiRuntimeMessage[];
}

function listDynamicSourceRefs(
  messages: A2uiRuntimeMessage[],
): Array<{ surfaceId: string; sourceId: string }> {
  return messages.flatMap((message) => {
    if (!isDataSourceUpdateMessage(message)) {
      return [];
    }
    return message.dataSourceUpdate.sources.map((source) => ({
      surfaceId: message.dataSourceUpdate.surfaceId,
      sourceId: source.id,
    }));
  });
}

function chooseSurfaceId(renderedSurfaceIds: string[], store: SurfaceStore): string {
  const surfaceId = renderedSurfaceIds[0] ?? null;
  if (surfaceId != null) {
    return surfaceId;
  }
  for (const surface of store.surfaces.values()) {
    if (isRenderableSurface(surface)) {
      return surface.surfaceId;
    }
  }
  throw new Error("A2UI messages did not define a renderable surface.");
}

function isRenderableSurface(surface: SurfaceState): boolean {
  return typeof surface.root === "string" && surface.root.length > 0;
}

function clampTtlMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_DYNAMIC_TTL_MS;
  }
  return Math.max(1_000, Math.min(Math.trunc(value), MAX_DYNAMIC_TTL_MS));
}

function logDynamicDataRuntime(level: "debug" | "info" | "warn" | "error", message: string): void {
  switch (level) {
    case "debug":
      logger.debug(message);
      return;
    case "info":
      logger.info(message);
      return;
    case "warn":
      logger.warn(message);
      return;
    case "error":
      logger.error(message);
      return;
  }
}

function buildConsumedActionKey(sourceComponentId: string, actionName: string): string {
  return `${sourceComponentId}\u0000${actionName}`;
}

function applyConsumedActionTransforms(
  card: Record<string, unknown>,
  consumedActionKeys: Set<string>,
): void {
  if (consumedActionKeys.size === 0) {
    return;
  }
  replaceConsumedActionNodes(card, consumedActionKeys);
}

function replaceConsumedActionNodes(value: unknown, consumedActionKeys: Set<string>): unknown {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = replaceConsumedActionNodes(value[index], consumedActionKeys);
    }
    return value;
  }
  if (!isRecord(value)) {
    return value;
  }

  if (isConsumedA2uiButton(value, consumedActionKeys)) {
    return {
      tag: "div",
      text: {
        tag: "plain_text",
        content: "已提交",
        text_align: "center",
        text_color: "grey",
      },
    };
  }

  for (const [key, child] of Object.entries(value)) {
    value[key] = replaceConsumedActionNodes(child, consumedActionKeys);
  }
  return value;
}

function isConsumedA2uiButton(
  node: Record<string, unknown>,
  consumedActionKeys: Set<string>,
): boolean {
  if (node.tag !== "button" || typeof node.name !== "string" || !isRecord(node.value)) {
    return false;
  }
  const value = node.value;
  if (value.__a2ui_lark !== "v0_8" || typeof value.actionName !== "string") {
    return false;
  }
  return consumedActionKeys.has(buildConsumedActionKey(node.name, value.actionName));
}

function shouldLogUpdate(updateCount: number): boolean {
  return updateCount <= 5 || updateCount % 10 === 0;
}

function summarizeRenderedSurface(
  surface: SurfaceState,
  card: Record<string, unknown>,
): Record<string, unknown> {
  const cardJson = JSON.stringify(card);
  return {
    surfaceId: surface.surfaceId,
    catalogId: surface.catalogId ?? null,
    root: surface.root ?? null,
    componentCount: surface.components.size,
    cardBytes: Buffer.byteLength(cardJson, "utf8"),
    taggedNodes: countTaggedNodes(card),
    bodyElementCount: readArrayLength(card, ["body", "elements"]),
    colorStyleCount: countColorStyles(card),
    grid: summarizeRootGrid(surface),
  };
}

function summarizeRootGrid(surface: SurfaceState): Record<string, unknown> | null {
  if (surface.root == null) {
    return null;
  }
  const root = surface.components.get(surface.root);
  const gridProps = root?.component.Grid;
  if (!isRecord(gridProps)) {
    return null;
  }
  const rows = readInteger(gridProps.rows);
  const cols = readInteger(gridProps.cols);
  const cellSize = readInteger(gridProps.cellSize);
  const cellBackgrounds = resolveBoundValueForSummary(gridProps.cellBackgrounds, surface.dataModel);
  const matrixSummary = summarizeColorMatrix(cellBackgrounds);
  return {
    rows,
    cols,
    cellSize,
    gap: readInteger(gridProps.gap),
    backgroundColor:
      typeof gridProps.backgroundColor === "string" ? gridProps.backgroundColor : null,
    cellBackgroundsPath: isRecord(gridProps.cellBackgrounds)
      ? typeof gridProps.cellBackgrounds.path === "string"
        ? gridProps.cellBackgrounds.path
        : null
      : null,
    ...matrixSummary,
  };
}

function summarizeColorMatrix(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {
      cellBackgroundRows: null,
      cellBackgroundCols: null,
      nonWhiteCells: null,
      uniqueColors: [],
      firstRowPreview: null,
    };
  }
  const rows = value;
  const cols = Array.isArray(rows[0]) ? rows[0].length : null;
  const colors = new Set<string>();
  let nonWhiteCells = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const cell of row) {
      if (typeof cell !== "string") {
        continue;
      }
      colors.add(cell);
      if (!isWhiteColor(cell)) {
        nonWhiteCells += 1;
      }
    }
  }
  const firstRow = Array.isArray(rows[0])
    ? rows[0].filter((cell): cell is string => typeof cell === "string").slice(0, 27)
    : null;
  return {
    cellBackgroundRows: rows.length,
    cellBackgroundCols: cols,
    nonWhiteCells,
    uniqueColors: Array.from(colors).slice(0, 12),
    firstRowPreview: firstRow,
  };
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (isRecord(value) && Array.isArray(value.pixels)) {
    return {
      keys: Object.keys(value),
      time: typeof value.time === "string" ? value.time : null,
      pixels: summarizeColorMatrix(value.pixels),
    };
  }
  return {
    type: Array.isArray(value) ? "array" : typeof value,
    preview: JSON.stringify(value).slice(0, 500),
  };
}

function resolveBoundValueForSummary(binding: unknown, dataModel: unknown): unknown {
  if (!isRecord(binding) || typeof binding.path !== "string") {
    return binding;
  }
  return getJsonPointerForSummary(dataModel, binding.path);
}

function getJsonPointerForSummary(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") {
    return value;
  }
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readArrayLength(value: unknown, path: string[]): number | null {
  const resolved = readPath(value, path);
  return Array.isArray(resolved) ? resolved.length : null;
}

function countColorStyles(card: Record<string, unknown>): number {
  const colorStyles = readPath(card, ["config", "style", "color"]);
  return isRecord(colorStyles) ? Object.keys(colorStyles).length : 0;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function countTaggedNodes(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countTaggedNodes(item), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  const self = typeof value.tag === "string" ? 1 : 0;
  return Object.values(value).reduce<number>((sum, item) => sum + countTaggedNodes(item), self);
}

function isWhiteColor(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll(/\s+/g, "");
  return (
    normalized === "#fff" ||
    normalized === "#ffffff" ||
    normalized === "white" ||
    normalized === "rgb(255,255,255)" ||
    normalized === "rgba(255,255,255,1)"
  );
}

interface LarkInteractiveMessageResponse {
  data?: {
    message_id?: string;
    open_message_id?: string;
  };
}

async function sendLarkInteractiveCardReferenceMessage(input: {
  client: LarkSdkClient;
  chatId: string;
  surfaceObject: Record<string, unknown>;
  cardId: string;
}): Promise<LarkInteractiveMessageResponse> {
  const threadReplyMessageId = readStringValue(input.surfaceObject.reply_to_message_id);
  const content = JSON.stringify({
    type: "card",
    data: {
      card_id: input.cardId,
    },
  });

  if (threadReplyMessageId != null) {
    return input.client.sdk.im.message.reply({
      path: { message_id: threadReplyMessageId },
      data: {
        msg_type: "interactive",
        content,
        reply_in_thread: true,
        uuid: randomUUID(),
      },
    }) as Promise<LarkInteractiveMessageResponse>;
  }

  return input.client.sdk.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.chatId,
      msg_type: "interactive",
      content,
      uuid: randomUUID(),
    },
  }) as Promise<LarkInteractiveMessageResponse>;
}

function getCardkitSdk(client: LarkSdkClient): {
  card: {
    create(input: { data: { type: "card_json"; data: string } }): Promise<LarkCardCreateResponse>;
    update(input: {
      path: { card_id: string };
      data: {
        card: { type: "card_json"; data: string };
        sequence: number;
      };
    }): Promise<LarkCardOperationResponse>;
  };
} {
  const sdk = client.sdk as unknown as {
    cardkit?: {
      v1?: {
        card?: {
          create?: (input: {
            data: {
              type: "card_json";
              data: string;
            };
          }) => Promise<LarkCardCreateResponse>;
          update?: (input: {
            path: { card_id: string };
            data: {
              card: { type: "card_json"; data: string };
              sequence: number;
            };
          }) => Promise<LarkCardOperationResponse>;
        };
      };
    };
  };

  const create = sdk.cardkit?.v1?.card?.create;
  const update = sdk.cardkit?.v1?.card?.update;
  if (create == null || update == null) {
    throw new Error("Lark CardKit SDK is not available on the configured client.");
  }

  return {
    card: {
      create,
      update,
    },
  };
}
