/**
 * Runtime bootstrap/composition root.
 *
 * This file wires concrete implementations for loop, runtime services,
 * orchestration bridge, cron, and channel runtimes. `main.ts` calls into this
 * module to keep process entry thin and business assembly centralized.
 */
import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { LiveProviderRegistrySource } from "@/src/agent/llm/provider-registry-source.js";
import { CodexProviderApiKeyResolver } from "@/src/agent/llm/providers/codex/resolver.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import { createLarkChannelRuntime, type LarkChannelRuntime } from "@/src/channels/lark/channel.js";
import { LarkClientRegistry } from "@/src/channels/lark/client.js";
import { createLarkSubagentConversationSurfaceProvisioner } from "@/src/channels/lark/subagent-provisioner.js";
import { listConfiguredLarkInstallations } from "@/src/channels/lark/types.js";
import { LiveConfigManager } from "@/src/config/live-manager.js";
import type { LoadConfigOptions } from "@/src/config/load.js";
import { ScenarioModelSwitchService } from "@/src/config/scenario-model-switch.js";
import type { AppConfig } from "@/src/config/schema.js";
import { CronService } from "@/src/cron/service.js";
import { MeditationPipelineRunner } from "@/src/meditation/runner.js";
import { MeditationScheduler } from "@/src/meditation/scheduler.js";
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
import { MinuteHeartbeat } from "@/src/runtime/minute-heartbeat.js";
import {
  createRuntimeOrchestrationBridge,
  type RuntimeOrchestrationBridge,
} from "@/src/runtime/orchestration-bridge.js";
import { RuntimeStatusService } from "@/src/runtime/status.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { HarnessEventsRepo } from "@/src/storage/repos/harness-events.repo.js";
import { MeditationStateRepo } from "@/src/storage/repos/meditation-state.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import { createBuiltinToolRegistry } from "@/src/tools/builtins.js";

const logger = createSubsystemLogger("runtime-bootstrap");

export interface RuntimeBootstrap {
  readonly bridge: RuntimeOrchestrationBridge;
  readonly ingress: SessionRuntimeIngress;
  readonly manager: AgentManager;
  readonly liveConfig: LiveConfigManager;
  readonly heartbeat: MinuteHeartbeat;
  readonly cron: CronService;
  readonly meditation: MeditationScheduler;
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
  configPaths?: Required<LoadConfigOptions>;
}

export function createRuntimeBootstrap(input: CreateRuntimeBootstrapInput): RuntimeBootstrap {
  const liveConfig = new LiveConfigManager({
    initialSnapshot: input.config,
    ...(input.configPaths == null ? {} : { filePaths: input.configPaths }),
  });
  const liveModels = new LiveProviderRegistrySource(liveConfig);
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
  const scenarioModelSwitch = new ScenarioModelSwitchService(liveConfig);
  const providerApiKeyResolver = new CodexProviderApiKeyResolver();
  const llmBridge = new PiBridge(providerApiKeyResolver);
  const status = new RuntimeStatusService({
    storage: input.storage,
    control,
    models: liveModels,
  });
  const loop = new AgentLoop({
    sessions: new AgentSessionService(sessions, messages),
    messages,
    models: liveModels,
    tools,
    cancel,
    modelRunner: new PiAgentModelRunner(llmBridge, tools),
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
    models: liveModels,
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
  const heartbeat = new MinuteHeartbeat();
  const meditationState = new MeditationStateRepo(input.storage);
  const meditation = new MeditationScheduler({
    config: input.config.selfHarness,
    state: meditationState,
    runner: new MeditationPipelineRunner({
      storage: input.storage,
      state: meditationState,
      config: input.config.selfHarness,
      models: liveModels,
      bridge: llmBridge,
      securityConfig: input.config.security,
    }),
  });
  heartbeat.subscribe("cron", (tickAt) => cron.onHeartbeatTick(tickAt));
  heartbeat.subscribe("meditation", (tickAt) => meditation.onHeartbeatTick(tickAt));
  const lark = createLarkChannelRuntime({
    config: input.config.channels.lark,
    storage: input.storage,
    ingress,
    control,
    status,
    modelSwitch: scenarioModelSwitch,
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
    taskThreads: {
      createFollowupExecution: ({ rootTaskRunId, initiatorThreadId, createdAt }) => {
        const created = manager.createTaskThreadFollowupExecution({
          rootTaskRunId,
          ...(initiatorThreadId === undefined ? {} : { initiatorThreadId }),
          ...(createdAt === undefined ? {} : { createdAt }),
        });
        return {
          taskRunId: created.taskRun.id,
          sessionId: created.executionSession.id,
          conversationId: created.taskRun.conversationId,
          branchId: created.taskRun.branchId,
        };
      },
      completeTaskExecution: (taskInput) => manager.completeTaskExecution(taskInput),
      blockTaskExecution: (taskInput) => manager.blockTaskExecution(taskInput),
      failTaskExecution: (taskInput) => manager.failTaskExecution(taskInput),
    },
    thinkTanks: {
      continueConsultation: ({ consultationId, prompt, createdAt }) =>
        manager.continueThinkTankConsultation({
          consultationId,
          prompt,
          ...(createdAt === undefined ? {} : { createdAt }),
        }),
    },
  });

  let started = false;
  let shuttingDown: Promise<void> | null = null;

  return {
    bridge,
    ingress,
    manager,
    liveConfig,
    heartbeat,
    cron,
    meditation,
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

      liveConfig.startWatching();
      lark.start();
      cron.start();
      meditation.start();
      heartbeat.start();
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
          heartbeatStarted: heartbeat.status().started,
          inFlightCronRuns: cron.status().inFlightRuns,
          inFlightMeditationRuns: meditation.status().inFlightRuns,
        });
        heartbeat.stop();
        await lark.shutdown();
        meditation.stop();
        cron.stop();
        await meditation.drain();
        await cron.drain();
        await liveConfig.shutdown();
        started = false;
        logger.info("runtime bootstrap shutdown complete");
      })().finally(() => {
        shuttingDown = null;
      });

      return shuttingDown;
    },
  };
}
