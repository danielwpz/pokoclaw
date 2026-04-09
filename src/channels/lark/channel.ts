/**
 * Lark channel runtime entry.
 *
 * Wires lark client registry, inbound monitor, and outbound renderer around
 * the shared runtime ingress/event-bus interfaces. This is the top-level
 * channel module started by runtime bootstrap.
 */
import type * as Lark from "@larksuiteoapi/node-sdk";
import { LarkClientRegistry } from "@/src/channels/lark/client.js";
import {
  createLarkInboundRuntime,
  type LarkInboundIngress,
  type LarkInboundRuntime,
} from "@/src/channels/lark/inbound.js";
import {
  createLarkOutboundRuntime,
  type LarkOutboundRuntime,
} from "@/src/channels/lark/outbound.js";
import {
  type ConfiguredLarkInstallation,
  isConfiguredLarkInstallation,
  listConfiguredLarkInstallations,
  listEnabledLarkInstallations,
} from "@/src/channels/lark/types.js";
import type { ScenarioModelSwitchService } from "@/src/config/scenario-model-switch.js";
import type { LarkChannelConfig } from "@/src/config/schema.js";
import type { ResolveSubagentCreationRequestResult } from "@/src/orchestration/agent-manager.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import type { RuntimeControlService } from "@/src/runtime/control.js";
import type { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import type { RuntimeStatusService } from "@/src/runtime/status.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";

const logger = createSubsystemLogger("channels/lark");

export interface LarkChannelRuntimeStatus {
  started: boolean;
  enabledInstallations: number;
  configuredInstallations: number;
  activeClients: number;
  activeInboundSockets: number;
}

export interface LarkChannelRuntime {
  readonly clients: LarkClientRegistry;
  readonly inbound: LarkInboundRuntime;
  readonly outbound: LarkOutboundRuntime;
  start(): void;
  shutdown(): Promise<void>;
  status(): LarkChannelRuntimeStatus;
}

export interface CreateLarkChannelRuntimeInput {
  config: LarkChannelConfig;
  storage: StorageDb;
  ingress: LarkInboundIngress;
  control: RuntimeControlService;
  status?: RuntimeStatusService;
  modelSwitch?: ScenarioModelSwitchService;
  outboundEventBus: RuntimeEventBus<OrchestratedOutboundEventEnvelope>;
  wsClientFactory?: (installation: ConfiguredLarkInstallation) => Lark.WSClient;
  clients?: LarkClientRegistry;
  subagentRequests?: {
    approve(requestId: string): Promise<ResolveSubagentCreationRequestResult>;
    deny(
      requestId: string,
    ): Promise<ResolveSubagentCreationRequestResult> | ResolveSubagentCreationRequestResult;
  };
}

export function createLarkChannelRuntime(input: CreateLarkChannelRuntimeInput): LarkChannelRuntime {
  const enabledInstallations = listEnabledLarkInstallations(input.config);
  const configuredInstallations = listConfiguredLarkInstallations(input.config);
  const clients = input.clients ?? new LarkClientRegistry(configuredInstallations);
  const inbound = createLarkInboundRuntime({
    installations: configuredInstallations,
    storage: input.storage,
    ingress: input.ingress,
    control: input.control,
    ...(input.status == null ? {} : { status: input.status }),
    ...(input.modelSwitch == null ? {} : { modelSwitch: input.modelSwitch }),
    clients,
    ...(input.wsClientFactory == null ? {} : { wsClientFactory: input.wsClientFactory }),
    ...(input.subagentRequests == null ? {} : { subagentRequests: input.subagentRequests }),
  });
  const outbound = createLarkOutboundRuntime({
    storage: input.storage,
    outboundEventBus: input.outboundEventBus,
    clients,
  });
  let started = false;

  return {
    clients,
    inbound,
    outbound,
    start() {
      if (started) {
        logger.debug("lark channel start skipped because it is already running");
        return;
      }

      for (const installation of enabledInstallations) {
        if (!isConfiguredLarkInstallation(installation)) {
          logger.warn("skipping enabled lark installation without credentials", {
            installationId: installation.installationId,
          });
        }
      }

      inbound.start();
      outbound.start();
      started = true;
      logger.info("lark channel started", {
        enabledInstallations: enabledInstallations.length,
        configuredInstallations: configuredInstallations.length,
        activeInboundSockets: inbound.status().activeSockets,
      });
    },

    async shutdown() {
      if (!started) {
        logger.debug("lark channel shutdown skipped because it never started");
        return;
      }

      await outbound.shutdown();
      await inbound.shutdown();
      clients.clear();
      started = false;
      logger.info("lark channel shutdown complete");
    },

    status(): LarkChannelRuntimeStatus {
      return {
        started,
        enabledInstallations: enabledInstallations.length,
        configuredInstallations: configuredInstallations.length,
        activeClients: clients.activeClientCount(),
        activeInboundSockets: inbound.status().activeSockets,
      };
    },
  };
}
