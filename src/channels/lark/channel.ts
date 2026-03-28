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
import type { LarkChannelConfig } from "@/src/config/schema.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import type { RuntimeEventBus } from "@/src/runtime/event-bus.js";
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
  outboundEventBus: RuntimeEventBus<OrchestratedOutboundEventEnvelope>;
  wsClientFactory?: (installation: ConfiguredLarkInstallation) => Lark.WSClient;
}

export function createLarkChannelRuntime(input: CreateLarkChannelRuntimeInput): LarkChannelRuntime {
  const enabledInstallations = listEnabledLarkInstallations(input.config);
  const configuredInstallations = listConfiguredLarkInstallations(input.config);
  const clients = new LarkClientRegistry(configuredInstallations);
  const inbound = createLarkInboundRuntime({
    installations: configuredInstallations,
    storage: input.storage,
    ingress: input.ingress,
    ...(input.wsClientFactory == null ? {} : { wsClientFactory: input.wsClientFactory }),
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
