import type { AgentRuntimeEvent } from "@/src/agent/events.js";
import type { AgentManager } from "@/src/orchestration/agent-manager.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { ToolRuntimeControl } from "@/src/tools/core/types.js";

const logger = createSubsystemLogger("runtime-orchestration-bridge");

type RuntimeOrchestrationTarget = Pick<
  AgentManager,
  "emitRuntimeEvent" | "submitSubagentCreationRequest" | "runCronJobNow"
>;

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
