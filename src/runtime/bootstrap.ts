/**
 * Runtime bootstrap/composition root.
 *
 * This file wires concrete implementations for loop, runtime services,
 * orchestration bridge, cron, and channel runtimes. `main.ts` calls into this
 * module to keep process entry thin and business assembly centralized.
 */
import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { CodexProviderApiKeyResolver } from "@/src/agent/llm/providers/codex/resolver.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { createLarkChannelRuntime, type LarkChannelRuntime } from "@/src/channels/lark/channel.js";
import { LarkClientRegistry } from "@/src/channels/lark/client.js";
import { createLarkSubagentConversationSurfaceProvisioner } from "@/src/channels/lark/subagent-provisioner.js";
import { listConfiguredLarkInstallations } from "@/src/channels/lark/types.js";
import type { AppConfig } from "@/src/config/schema.js";
import { CronService } from "@/src/cron/service.js";
import { AgentManager, type AgentManagerDependencies } from "@/src/orchestration/agent-manager.js";
import type { OrchestratedOutboundEventEnvelope } from "@/src/orchestration/outbound-events.js";
import {
  dispatchPreparedBackOnlineRecovery,
  type PreparedBackOnlineRecovery,
  prepareBackOnlineRecovery,
} from "@/src/runtime/back-online.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { RuntimeControlService } from "@/src/runtime/control.js";
import { RuntimeEventBus } from "@/src/runtime/event-bus.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
import {
  createRuntimeOrchestrationBridge,
  type RuntimeOrchestrationBridge,
} from "@/src/runtime/orchestration-bridge.js";
import { RuntimeStatusService } from "@/src/runtime/status.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { HarnessEventsRepo } from "@/src/storage/repos/harness-events.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { createBuiltinToolRegistry } from "@/src/tools/builtins.js";

const logger = createSubsystemLogger("runtime-bootstrap");

export interface RuntimeBootstrap {
  readonly bridge: RuntimeOrchestrationBridge;
  readonly ingress: SessionRuntimeIngress;
  readonly manager: AgentManager;
  readonly cron: CronService;
  readonly lark: LarkChannelRuntime;
  readonly control: RuntimeControlService;
  readonly status: RuntimeStatusService;
  readonly outboundEventBus: RuntimeEventBus<OrchestratedOutboundEventEnvelope>;
  start(): void;
  shutdown(): Promise<void>;
}

export interface CreateRuntimeBootstrapInput {
  config: AppConfig;
  storage: StorageDb;
  subagentProvisioner?: AgentManagerDependencies["subagentProvisioner"];
  previousLastSeenAt?: Date | null;
}

export function createRuntimeBootstrap(input: CreateRuntimeBootstrapInput): RuntimeBootstrap {
  const messages = new MessagesRepo(input.storage);
  const sessions = new SessionsRepo(input.storage);
  const tools = createBuiltinToolRegistry({
    providers: input.config.providers,
    tools: input.config.tools,
  });
  const bridge = createRuntimeOrchestrationBridge();
  const outboundEventBus = new RuntimeEventBus<OrchestratedOutboundEventEnvelope>();
  const cancel = new SessionRunAbortRegistry();
  const control = new RuntimeControlService(cancel, {
    harnessEvents: new HarnessEventsRepo(input.storage),
    sessions,
    taskRuns: new TaskRunsRepo(input.storage),
  });
  const models = new ProviderRegistry(input.config);
  const providerApiKeyResolver = new CodexProviderApiKeyResolver();
  const status = new RuntimeStatusService({
    storage: input.storage,
    control,
    models,
  });
  const loop = new AgentLoop({
    sessions: new AgentSessionService(sessions, messages),
    messages,
    models,
    tools,
    cancel,
    modelRunner: new PiAgentModelRunner(new PiBridge(providerApiKeyResolver), tools),
    storage: input.storage,
    securityConfig: input.config.security,
    compaction: input.config.compaction,
    runtime: input.config.runtime,
    runtimeControl: bridge.runtimeControl,
    control,
    emitEvent: bridge.emitRuntimeEvent,
  });

  const ingress = new SessionRuntimeIngress({
    loop,
    messages,
  });
  const larkClients = new LarkClientRegistry(
    listConfiguredLarkInstallations(input.config.channels.lark),
  );
  const manager = new AgentManager({
    storage: input.storage,
    ingress,
    outboundEventBus,
    subagentProvisioner:
      input.subagentProvisioner ??
      createLarkSubagentConversationSurfaceProvisioner({
        storage: input.storage,
        clients: larkClients,
      }),
  });
  bridge.attachManager(manager);

  const cron = new CronService({
    storage: input.storage,
    agentManager: manager,
  });
  const lark = createLarkChannelRuntime({
    config: input.config.channels.lark,
    storage: input.storage,
    ingress,
    control,
    status,
    outboundEventBus,
    clients: larkClients,
    subagentRequests: {
      approve: (requestId: string) =>
        manager.resolveApproveSubagentCreationRequest({
          requestId,
        }),
      deny: (requestId: string) =>
        manager.resolveDenySubagentCreationRequest({
          requestId,
          reasonText: "Denied from lark subagent creation card",
        }),
    },
  });

  let started = false;
  let shuttingDown: Promise<void> | null = null;

  return {
    bridge,
    ingress,
    manager,
    cron,
    lark,
    control,
    status,
    outboundEventBus,
    start() {
      if (started) {
        logger.debug("runtime bootstrap start skipped because it is already running");
        return;
      }

      let preparedBackOnline: PreparedBackOnlineRecovery = {
        status: "skipped",
        generatedAt: new Date(),
        notices: [],
      };
      try {
        preparedBackOnline = prepareBackOnlineRecovery({
          storage: input.storage,
          clients: larkClients,
          previousLastSeenAt: input.previousLastSeenAt ?? null,
        });
      } catch (error) {
        logger.warn("failed to prepare back-online recovery", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      lark.start();
      cron.start();
      started = true;
      logger.info("runtime bootstrap started", {
        providerCount: Object.keys(input.config.providers).length,
        modelCount: input.config.models.catalog.length,
        toolCount: tools.list().length,
        larkInstallations: lark.status().configuredInstallations,
      });

      void dispatchPreparedBackOnlineRecovery({
        storage: input.storage,
        clients: larkClients,
        prepared: preparedBackOnline,
      }).catch((error: unknown) => {
        logger.warn("back-online recovery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    shutdown() {
      if (shuttingDown != null) {
        return shuttingDown;
      }

      shuttingDown = (async () => {
        if (!started) {
          logger.debug("runtime bootstrap shutdown skipped because it never started");
          return;
        }

        logger.info("runtime bootstrap shutting down", {
          inFlightCronRuns: cron.status().inFlightRuns,
        });
        await lark.shutdown();
        cron.stop();
        await cron.drain();
        started = false;
        logger.info("runtime bootstrap shutdown complete");
      })().finally(() => {
        shuttingDown = null;
      });

      return shuttingDown;
    },
  };
}
