/**
 * Runtime-to-orchestration bridge.
 *
 * Exposes a narrow interface from runtime/tool layer into AgentManager without
 * creating a direct dependency cycle. Used for runtime event handoff and
 * runtime-control actions like subagent creation and manual cron triggers.
 */
import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import type { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { ThinkTankCapabilities } from "@/src/think-tank/types.js";
import type { ToolRuntimeControl } from "@/src/tools/core/types.js";

const logger = createSubsystemLogger("runtime-orchestration-bridge");

type RuntimeOrchestrationTarget = Pick<
  AgentManager,
  | "emitRuntimeEvent"
  | "submitSubagentCreationRequest"
  | "runCronJobNow"
  | "startBackgroundTask"
  | "suppressBackgroundTaskCompletionNotice"
> & {
  getThinkTankCapabilities?: (input: {
    sourceSessionId: string;
  }) => Promise<ThinkTankCapabilities> | ThinkTankCapabilities;
  startThinkTankConsultation?: ToolRuntimeControl["startThinkTankConsultation"];
  consultThinkTankParticipant?: ToolRuntimeControl["consultThinkTankParticipant"];
  upsertThinkTankEpisodeStep?: ToolRuntimeControl["upsertThinkTankEpisodeStep"];
  getThinkTankStatus?: ToolRuntimeControl["getThinkTankStatus"];
};

export class RuntimeOrchestrationBridge {
  private manager: RuntimeOrchestrationTarget | null = null;

  readonly runtimeControl: Omit<ToolRuntimeControl, "submitApprovalDecision"> = {
    requestSubagentCreation: async (input) => {
      const submitted =
        this.requireManager("requestSubagentCreation").submitSubagentCreationRequest(input);

      logger.info("submitted subagent creation request through runtime bridge", {
        requestId: submitted.request.id,
        sourceSessionId: input.sourceSessionId,
        title: submitted.request.title,
      });

      return {
        requestId: submitted.request.id,
        title: submitted.request.title,
        workdir: submitted.workdir,
        privateWorkspaceDir: submitted.privateWorkspaceDir,
        status: "pending_confirmation" as const,
        expiresAt: submitted.request.expiresAt,
      };
    },
    runCronJobNow: async (input) => {
      const result = await this.requireManager("runCronJobNow").runCronJobNow(input);

      logger.info("submitted cron job run through runtime bridge", {
        cronJobId: input.jobId,
        accepted: result.accepted,
      });

      return result;
    },
    startBackgroundTask: async (input) => {
      const result = await this.requireManager("startBackgroundTask").startBackgroundTask(input);

      logger.info("submitted background task through runtime bridge", {
        sourceSessionId: input.sourceSessionId,
        taskRunId: result.taskRunId,
        accepted: result.accepted,
      });

      return result;
    },
    getThinkTankCapabilities: async (input) => {
      const manager = this.requireManager("getThinkTankCapabilities");
      if (manager.getThinkTankCapabilities == null) {
        throw new Error(
          "RuntimeOrchestrationBridge cannot getThinkTankCapabilities before think tank runtime is attached.",
        );
      }
      return await manager.getThinkTankCapabilities(input);
    },
    startThinkTankConsultation: async (input) => {
      const manager = this.requireManager("startThinkTankConsultation");
      if (manager.startThinkTankConsultation == null) {
        throw new Error(
          "RuntimeOrchestrationBridge cannot startThinkTankConsultation before think tank runtime is attached.",
        );
      }
      return await manager.startThinkTankConsultation(input);
    },
    consultThinkTankParticipant: async (input) => {
      const manager = this.requireManager("consultThinkTankParticipant");
      if (manager.consultThinkTankParticipant == null) {
        throw new Error(
          "RuntimeOrchestrationBridge cannot consultThinkTankParticipant before think tank runtime is attached.",
        );
      }
      return await manager.consultThinkTankParticipant(input);
    },
    upsertThinkTankEpisodeStep: async (input) => {
      const manager = this.requireManager("upsertThinkTankEpisodeStep");
      if (manager.upsertThinkTankEpisodeStep == null) {
        throw new Error(
          "RuntimeOrchestrationBridge cannot upsertThinkTankEpisodeStep before think tank runtime is attached.",
        );
      }
      return await manager.upsertThinkTankEpisodeStep(input);
    },
    getThinkTankStatus: async (input) => {
      const manager = this.requireManager("getThinkTankStatus");
      if (manager.getThinkTankStatus == null) {
        throw new Error(
          "RuntimeOrchestrationBridge cannot getThinkTankStatus before think tank runtime is attached.",
        );
      }
      return await manager.getThinkTankStatus(input);
    },
    suppressBackgroundTaskCompletionNotice: (input) => {
      this.requireManager(
        "suppressBackgroundTaskCompletionNotice",
      ).suppressBackgroundTaskCompletionNotice(input);
    },
  };

  attachManager(manager: RuntimeOrchestrationTarget): void {
    this.manager = manager;
  }

  emitRuntimeEvent = (event: AgentRuntimeEvent): void => {
    this.requireManager("emitRuntimeEvent").emitRuntimeEvent(event);
  };

  private requireManager(action: string): RuntimeOrchestrationTarget {
    if (this.manager != null) {
      return this.manager;
    }

    throw new Error(
      `RuntimeOrchestrationBridge cannot ${action} before an AgentManager is attached.`,
    );
  }
}

export function createRuntimeOrchestrationBridge(
  input: { manager?: RuntimeOrchestrationTarget } = {},
): RuntimeOrchestrationBridge {
  const bridge = new RuntimeOrchestrationBridge();
  if ("manager" in input && input.manager != null) {
    bridge.attachManager(input.manager);
  }
  return bridge;
}
