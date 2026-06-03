import { randomUUID } from "node:crypto";
import {
  type A2uiComponentNode,
  type A2uiServerMessage,
  type A2uiUserActionEvent,
  type ActionContextEntry,
  type BoundValue,
  CALLBACK_ENVELOPE_VERSION,
  extractLarkCallback,
  formatValidationIssues,
  type NormalizedCallbackInput,
  normalizeCallback,
  readComponentRef,
  renderSurface,
  resolveBoundValue,
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
import { A2uiSurfacePublicationsRepo } from "@/src/storage/repos/a2ui-surface-publications.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { A2uiSurfacePublication as StoredA2uiSurfacePublication } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("channels/lark-a2ui");
const LARK_A2UI_CHANNEL_TYPE = "lark";
const A2UI_DYNAMIC_DATA_UNSUPPORTED_MESSAGE =
  "A2UI dynamic data sources are not supported in Pokoclaw A2UI 1.0.";
const A2UI_PATH_CONTEXT_UNSUPPORTED_MESSAGE =
  "A2UI callback context cannot reference dataModel paths in Pokoclaw A2UI 1.0.";
const A2UI_PUBLICATION_ID_KEY = "publicationId";

export interface A2uiPublishInput {
  sessionId: string;
  conversationId: string;
  messages: unknown;
}

export interface A2uiPublishResult {
  surfaceId: string;
  cardId: string;
  messageId?: string;
  sequence: number;
  warnings: string[];
}

interface HydratedA2uiSurfacePublication {
  id: string;
  surfaceId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  channelInstallationId: string;
  cardId: string;
  messageId?: string;
  sequence: number;
  store: SurfaceStore;
  consumedActionKeys: Set<string>;
}

export class LarkA2uiService {
  private readonly publicationRepo: A2uiSurfacePublicationsRepo;
  private readonly updateChains = new Map<string, Promise<void>>();
  private readonly updateCounts = new Map<string, number>();

  constructor(
    private readonly deps: {
      storage: StorageDb;
      clients: {
        getOrCreate(installationId: string): LarkSdkClient;
      };
      ingress: LarkInboundIngress;
    },
  ) {
    this.publicationRepo = new A2uiSurfacePublicationsRepo(deps.storage);
  }

  async publish(input: A2uiPublishInput): Promise<A2uiPublishResult> {
    if (containsDynamicDataSourceUpdate(input.messages)) {
      throw new Error(A2UI_DYNAMIC_DATA_UNSUPPORTED_MESSAGE);
    }

    const validation = validateA2uiMessages(input.messages);
    if (!validation.ok) {
      throw new Error(`Invalid A2UI messages:\n${formatValidationIssues(validation.issues)}`);
    }

    const messages = normalizeMessages(input.messages);
    const store = new SurfaceStore();
    store.applyMessages(messages);

    const surfaceId = chooseSurfaceId(validation.renderedSurfaceIds, store);
    assertSupportedCallbackContext(store);
    const surface = store.getSurface(surfaceId);
    const rendered = renderSurface(surface);
    const publicationId = randomUUID();
    attachPublicationIdToCard(rendered.card, publicationId);
    logger.info("rendered a2ui surface before publish", {
      surfaceId,
      renderSummary: summarizeRenderedSurface(surface, rendered.card),
      warnings: rendered.warnings.map((warning) => warning.message),
    });
    const session = new SessionsRepo(this.deps.storage).getById(input.sessionId);
    if (session == null) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }

    const deliveryTargets = listLarkDeliveryTargets(this.deps.storage, {
      conversationId: input.conversationId,
      branchId: session.branchId,
    });
    if (deliveryTargets.length > 1) {
      throw new Error(
        "Multiple Lark delivery targets are paired for this conversation. A2UI publish requires an unambiguous current Lark surface.",
      );
    }
    const target = deliveryTargets[0];
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

    const publication = this.publicationRepo.upsert({
      id: publicationId,
      surfaceId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: session.branchId,
      channelType: LARK_A2UI_CHANNEL_TYPE,
      channelInstallationId: target.channelInstallationId,
      channelArtifactId: cardId,
      ...(messageId === undefined ? {} : { channelMessageId: messageId }),
      channelSequence: 1,
      surfaceStateJson: serializeSurfaceState(surface),
      consumedActionKeysJson: "[]",
    });

    logger.info("published a2ui surface", {
      surfaceId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: session.branchId,
      channelInstallationId: target.channelInstallationId,
      cardId,
      messageId: messageId ?? null,
      renderSummary: summarizeRenderedSurface(surface, rendered.card),
    });

    return {
      surfaceId,
      cardId,
      ...(messageId === undefined ? {} : { messageId }),
      sequence: publication.channelSequence,
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

    const publicationId = readPublicationIdFromLarkPayload(input.payload);
    const storedPublication =
      publicationId == null ? null : this.publicationRepo.getById(publicationId);
    if (storedPublication?.status !== "active") {
      return {
        toast: {
          type: "error",
          content: "A2UI state 已过期，请重新发送卡片。",
        },
      };
    }
    let publication: HydratedA2uiSurfacePublication;
    try {
      publication = hydrateA2uiPublication(storedPublication);
    } catch (error) {
      logger.warn("failed to hydrate stored a2ui publication", {
        surfaceId: callback.envelope.surfaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        toast: {
          type: "error",
          content: "A2UI state 无法恢复，请重新发送卡片。",
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
    let agentEvent: A2uiAgentUserActionEvent;
    try {
      const surface = publication.store.getSurface(callback.envelope.surfaceId);
      event = normalizeCallback(surface, callback);
      agentEvent = buildAgentUserActionEvent(surface, event, callback);
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
    const consumeResult = this.publicationRepo.consumeAction({
      id: publication.id,
      actionKey,
      surfaceStateJson: serializePublicationSurfaceState(publication),
    });
    if (consumeResult.status === "duplicate") {
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

    if (consumeResult.status === "missing") {
      return {
        toast: {
          type: "error",
          content: "A2UI state 已过期，请重新发送卡片。",
        },
      };
    }
    void this.enqueueSurfaceUpdate(publication.id).catch((error: unknown) => {
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
        content: `A2UI user action:\n${JSON.stringify(agentEvent, null, 2)}`,
        messageType: "a2ui_user_action",
        channelMessageId: `a2ui:${publication.surfaceId}:${randomUUID()}`,
        createdAt: new Date(),
        // A2UI callbacks should stay short: handle the structured user action and update/respond,
        // rather than letting one button click start an unbounded chat run in the background.
        maxTurns: 6,
      })
      .catch((error: unknown) => {
        logger.warn("failed to submit a2ui callback to runtime ingress", {
          surfaceId: callback.envelope.surfaceId,
          sessionId: publication.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        void this.restoreConsumedActionAfterSubmissionFailure({
          publicationId: publication.id,
          actionKey,
          surfaceId: publication.surfaceId,
          sourceComponentId: event.userAction.sourceComponentId,
          actionName: event.userAction.name,
        }).catch((restoreError: unknown) => {
          logger.warn("failed to restore a2ui consumed action after ingress failure", {
            surfaceId: publication.surfaceId,
            sessionId: publication.sessionId,
            error: restoreError instanceof Error ? restoreError.message : String(restoreError),
          });
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
    this.updateChains.clear();
    this.updateCounts.clear();
  }

  private async restoreConsumedActionAfterSubmissionFailure(input: {
    publicationId: string;
    actionKey: string;
    surfaceId: string;
    sourceComponentId: string;
    actionName: string;
  }): Promise<void> {
    const restoreResult = this.publicationRepo.restoreConsumedAction({
      id: input.publicationId,
      actionKey: input.actionKey,
    });
    if (restoreResult.status !== "restored") {
      return;
    }

    logger.warn("restored a2ui consumed action after ingress submission failure", {
      surfaceId: input.surfaceId,
      publicationId: input.publicationId,
      sourceComponentId: input.sourceComponentId,
      actionName: input.actionName,
    });
    await this.enqueueSurfaceUpdate(input.publicationId);
  }

  private async enqueueSurfaceUpdate(publicationId: string): Promise<void> {
    const storedPublication = this.publicationRepo.getById(publicationId);
    if (storedPublication?.status !== "active") {
      return;
    }

    const previous = this.updateChains.get(publicationId) ?? Promise.resolve();
    const next = previous
      .catch((error: unknown) => {
        logger.warn("previous a2ui surface update failed before queued update", {
          publicationId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => this.updateSurfaceNow(publicationId));
    this.updateChains.set(
      publicationId,
      next.catch(() => {}),
    );
    await next;
  }

  private async updateSurfaceNow(publicationId: string): Promise<void> {
    const storedPublication = this.publicationRepo.getById(publicationId);
    if (storedPublication?.status !== "active") {
      return;
    }
    const publication = hydrateA2uiPublication(storedPublication);
    const surfaceId = publication.surfaceId;

    const client = this.deps.clients.getOrCreate(publication.channelInstallationId);
    const cardkit = getCardkitSdk(client);
    const surface = publication.store.getSurface(surfaceId);
    const rendered = renderSurface(surface);
    attachPublicationIdToCard(rendered.card, publication.id);
    applyConsumedActionTransforms(rendered.card, publication.consumedActionKeys);
    const sequence = publication.sequence + 1;
    const nextUpdateCount = (this.updateCounts.get(publicationId) ?? 0) + 1;
    if (shouldLogUpdate(nextUpdateCount)) {
      logger.info("updating a2ui surface", {
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
      this.publicationRepo.patch({
        id: publicationId,
        channelSequence: sequence,
      });
      this.updateCounts.set(publicationId, nextUpdateCount);
      if (shouldLogUpdate(nextUpdateCount)) {
        logger.info("updated a2ui surface", {
          surfaceId,
          updateCount: nextUpdateCount,
          channelInstallationId: publication.channelInstallationId,
          cardId: publication.cardId,
          sequence,
        });
      }
      logger.debug("updated a2ui surface debug", {
        surfaceId,
        channelInstallationId: publication.channelInstallationId,
        cardId: publication.cardId,
        sequence,
      });
      return;
    }

    const reconciledSequence = Math.max(publication.sequence, outcome.nextSequenceFloor - 1);
    this.publicationRepo.patch({
      id: publicationId,
      channelSequence: reconciledSequence,
    });
    this.updateCounts.set(publicationId, nextUpdateCount);
    logger.warn("a2ui surface update needs sequence reconcile", {
      surfaceId,
      updateCount: nextUpdateCount,
      nextSequenceFloor: outcome.nextSequenceFloor,
      sequenceAfterReconcile: reconciledSequence,
      reason: outcome.reason,
    });
  }
}

interface SerializedA2uiSurfaceState {
  surfaceId: string;
  catalogId?: string;
  root?: string;
  styles: Record<string, unknown>;
  components: A2uiComponentNode[];
  dataModel: unknown;
}

function hydrateA2uiPublication(row: StoredA2uiSurfacePublication): HydratedA2uiSurfacePublication {
  const surface = deserializeSurfaceState(row.surfaceStateJson);
  if (surface.surfaceId !== row.surfaceId) {
    throw new Error(
      `Stored A2UI surface state '${surface.surfaceId}' does not match publication '${row.surfaceId}'`,
    );
  }
  const store = new SurfaceStore();
  store.surfaces.set(surface.surfaceId, surface);
  return {
    id: row.id,
    surfaceId: row.surfaceId,
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    branchId: row.branchId,
    channelInstallationId: row.channelInstallationId,
    cardId: row.channelArtifactId,
    ...(row.channelMessageId == null ? {} : { messageId: row.channelMessageId }),
    sequence: row.channelSequence,
    store,
    consumedActionKeys: parseConsumedActionKeys(row.consumedActionKeysJson),
  };
}

function serializePublicationSurfaceState(publication: HydratedA2uiSurfacePublication): string {
  return serializeSurfaceState(publication.store.getSurface(publication.surfaceId));
}

function serializeSurfaceState(surface: SurfaceState): string {
  const serialized: SerializedA2uiSurfaceState = {
    surfaceId: surface.surfaceId,
    ...(surface.catalogId === undefined ? {} : { catalogId: surface.catalogId }),
    ...(surface.root === undefined ? {} : { root: surface.root }),
    styles: surface.styles,
    components: Array.from(surface.components.values()),
    dataModel: surface.dataModel,
  };
  return JSON.stringify(serialized);
}

function deserializeSurfaceState(value: string): SurfaceState {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || typeof parsed.surfaceId !== "string") {
    throw new Error("Stored A2UI surface state is invalid.");
  }
  if (!Array.isArray(parsed.components)) {
    throw new Error("Stored A2UI surface state components must be an array.");
  }
  const components = new Map<string, A2uiComponentNode>();
  for (const component of parsed.components) {
    if (!isA2uiComponentNode(component)) {
      throw new Error("Stored A2UI surface state contains an invalid component.");
    }
    components.set(component.id, component);
  }

  const surface: SurfaceState = {
    surfaceId: parsed.surfaceId,
    styles: isRecord(parsed.styles) ? parsed.styles : {},
    components,
    dataModel: "dataModel" in parsed ? parsed.dataModel : {},
  };
  if (typeof parsed.catalogId === "string") {
    surface.catalogId = parsed.catalogId;
  }
  if (typeof parsed.root === "string") {
    surface.root = parsed.root;
  }
  return surface;
}

function isA2uiComponentNode(value: unknown): value is A2uiComponentNode {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.component)) {
    return false;
  }
  return value.weight === undefined || typeof value.weight === "number";
}

function parseConsumedActionKeys(value: string): Set<string> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Stored A2UI consumed action keys are invalid.");
  }
  return new Set(parsed);
}

function normalizeMessages(value: unknown): A2uiServerMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("publish_a2ui.messages must be an array of A2UI runtime messages.");
  }
  return value as A2uiServerMessage[];
}

function containsDynamicDataSourceUpdate(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((message) => isRecord(message) && "dataSourceUpdate" in message);
}

function attachPublicationIdToCard(value: unknown, publicationId: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      attachPublicationIdToCard(entry, publicationId);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (isA2uiCallbackEnvelope(value.value)) {
    value.value[A2UI_PUBLICATION_ID_KEY] = publicationId;
  }

  for (const child of Object.values(value)) {
    attachPublicationIdToCard(child, publicationId);
  }
}

function readPublicationIdFromLarkPayload(payload: unknown): string | null {
  const root = isRecord(payload) ? payload : null;
  const event =
    root != null && isRecord(root.event) && isRecord(root.event.action)
      ? root.event
      : root != null && isRecord(root.action)
        ? root
        : null;
  if (event == null || !isRecord(event.action)) {
    return null;
  }

  const value = parseMaybeJson(event.action.value);
  if (
    isA2uiCallbackEnvelope(value) &&
    typeof value[A2UI_PUBLICATION_ID_KEY] === "string" &&
    value[A2UI_PUBLICATION_ID_KEY].length > 0
  ) {
    return value[A2UI_PUBLICATION_ID_KEY];
  }
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isA2uiCallbackEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.__a2ui_lark === CALLBACK_ENVELOPE_VERSION &&
    typeof value.surfaceId === "string" &&
    typeof value.sourceComponentId === "string"
  );
}

interface A2uiAgentUserActionEvent {
  userAction: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    timestamp: string;
    context: Record<string, unknown>;
    submittedValues: Record<string, unknown>;
  };
}

function buildAgentUserActionEvent(
  surface: SurfaceState,
  event: A2uiUserActionEvent,
  callback: NormalizedCallbackInput,
): A2uiAgentUserActionEvent {
  return {
    userAction: {
      name: event.userAction.name,
      surfaceId: event.userAction.surfaceId,
      sourceComponentId: event.userAction.sourceComponentId,
      timestamp: event.userAction.timestamp,
      context: resolveLiteralActionContext(
        readButtonActionContext(surface, event.userAction.sourceComponentId),
        surface.surfaceId,
        event.userAction.sourceComponentId,
      ),
      submittedValues: callback.submittedValues ?? {},
    },
  };
}

function assertSupportedCallbackContext(store: SurfaceStore): void {
  for (const surface of store.surfaces.values()) {
    for (const component of surface.components.values()) {
      const ref = readComponentRef(surface, component.id);
      if (ref.type !== "Button") {
        continue;
      }
      const context = readButtonActionContext(surface, ref.id);
      for (const entry of context) {
        if (hasPathBoundValue(entry.value)) {
          throw new Error(
            `${A2UI_PATH_CONTEXT_UNSUPPORTED_MESSAGE} surfaceId=${surface.surfaceId} componentId=${ref.id} key=${entry.key}`,
          );
        }
      }
    }
  }
}

function readButtonActionContext(surface: SurfaceState, componentId: string): ActionContextEntry[] {
  const ref = readComponentRef(surface, componentId);
  if (ref.type !== "Button") {
    return [];
  }
  const action = ref.props.action;
  if (!isRecord(action) || !Array.isArray(action.context)) {
    return [];
  }
  return action.context.filter(isActionContextEntry);
}

function resolveLiteralActionContext(
  context: ActionContextEntry[],
  surfaceId: string,
  componentId: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const entry of context) {
    if (hasPathBoundValue(entry.value)) {
      throw new Error(
        `${A2UI_PATH_CONTEXT_UNSUPPORTED_MESSAGE} surfaceId=${surfaceId} componentId=${componentId} key=${entry.key}`,
      );
    }
    resolved[entry.key] = resolveBoundValue(entry.value, {});
  }
  return resolved;
}

function isActionContextEntry(value: unknown): value is ActionContextEntry {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    isRecord(value.value) &&
    isBoundValue(value.value)
  );
}

function isBoundValue(value: unknown): value is BoundValue {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.path === "string" ||
    typeof value.literalString === "string" ||
    typeof value.literalNumber === "number" ||
    typeof value.literalBoolean === "boolean" ||
    (Array.isArray(value.literalArray) &&
      value.literalArray.every((entry) => typeof entry === "string"))
  );
}

function hasPathBoundValue(value: BoundValue): boolean {
  return typeof value.path === "string";
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
