import { PiAgentModelRunner, PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import { AgentLoop } from "@/src/agent/loop.js";
import { AgentSessionService } from "@/src/agent/session.js";
import type { AppConfig } from "@/src/config/schema.js";
import { CronService } from "@/src/cron/service.js";
import { AgentManager, type AgentManagerDependencies } from "@/src/orchestration/agent-manager.js";
import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { SessionRuntimeIngress } from "@/src/runtime/ingress.js";
import {
  createRuntimeOrchestrationBridge,
  type RuntimeOrchestrationBridge,
} from "@/src/runtime/orchestration-bridge.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { createBuiltinToolRegistry } from "@/src/tools/builtins.js";

const logger = createSubsystemLogger("runtime-bootstrap");

export interface RuntimeBootstrap {
  readonly bridge: RuntimeOrchestrationBridge;
  readonly ingress: SessionRuntimeIngress;
  readonly manager: AgentManager;
  readonly cron: CronService;
  start(): void;
  shutdown(): Promise<void>;
}

export interface CreateRuntimeBootstrapInput {
  config: AppConfig;
  storage: StorageDb;
  subagentProvisioner?: AgentManagerDependencies["subagentProvisioner"];
}

export function createRuntimeBootstrap(input: CreateRuntimeBootstrapInput): RuntimeBootstrap {
  const messages = new MessagesRepo(input.storage);
  const sessions = new SessionsRepo(input.storage);
  const tools = createBuiltinToolRegistry();
  const bridge = createRuntimeOrchestrationBridge();
  const loop = new AgentLoop({
    sessions: new AgentSessionService(sessions, messages),
    messages,
    models: new ProviderRegistry(input.config),
    tools,
    cancel: new SessionRunAbortRegistry(),
    modelRunner: new PiAgentModelRunner(new PiBridge(), tools),
    storage: input.storage,
    securityConfig: input.config.security,
    compaction: input.config.compaction,
    runtimeControl: bridge.runtimeControl,
    emitEvent: bridge.emitRuntimeEvent,
  });

  const ingress = new SessionRuntimeIngress({
    loop,
    messages,
  });
  const manager = new AgentManager({
    storage: input.storage,
    ingress,
    ...(input.subagentProvisioner == null
      ? {}
      : { subagentProvisioner: input.subagentProvisioner }),
  });
  bridge.attachManager(manager);

  const cron = new CronService({
    storage: input.storage,
    agentManager: manager,
  });

  let started = false;
  let shuttingDown: Promise<void> | null = null;

  return {
    bridge,
    ingress,
    manager,
    cron,
    start() {
      if (started) {
        logger.debug("runtime bootstrap start skipped because it is already running");
        return;
      }

      cron.start();
      started = true;
      logger.info("runtime bootstrap started", {
        providerCount: Object.keys(input.config.providers).length,
        modelCount: input.config.models.catalog.length,
        toolCount: tools.list().length,
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
