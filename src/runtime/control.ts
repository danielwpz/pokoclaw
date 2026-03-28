import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("runtime-control");

export interface ActiveRunRecord {
  runId: string;
  sessionId: string;
  conversationId: string;
  branchId: string;
  scenario: ModelScenario;
}

export interface StopRunInput {
  runId: string;
  actor: string;
  reasonText?: string;
}

export interface StopConversationInput {
  conversationId: string;
  actor: string;
  reasonText?: string;
}

export interface StopRunResult {
  accepted: boolean;
  runId: string;
  sessionId: string | null;
  conversationId: string | null;
}

export interface StopConversationResult {
  acceptedCount: number;
  conversationId: string;
  runIds: string[];
  sessionIds: string[];
}

export class RuntimeControlService {
  private readonly runsByRunId = new Map<string, ActiveRunRecord>();

  constructor(private readonly cancel: SessionRunAbortRegistry) {}

  beginRun(input: ActiveRunRecord): void {
    this.runsByRunId.set(input.runId, input);
    logger.debug("registered active run", {
      runId: input.runId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      scenario: input.scenario,
    });
  }

  finishRun(runId: string): void {
    const existing = this.runsByRunId.get(runId);
    if (existing == null) {
      return;
    }

    this.runsByRunId.delete(runId);
    logger.debug("released active run", {
      runId,
      sessionId: existing.sessionId,
      conversationId: existing.conversationId,
    });
  }

  stopRun(input: StopRunInput): StopRunResult {
    const run = this.runsByRunId.get(input.runId) ?? null;
    if (run == null) {
      logger.info("stop run ignored because no active run matched", {
        runId: input.runId,
        actor: input.actor,
      });
      return {
        accepted: false,
        runId: input.runId,
        sessionId: null,
        conversationId: null,
      };
    }

    const accepted = this.cancel.cancel(
      run.sessionId,
      input.reasonText ?? `stop requested by ${input.actor}`,
    );
    logger.info("processed stop run request", {
      runId: input.runId,
      sessionId: run.sessionId,
      conversationId: run.conversationId,
      actor: input.actor,
      accepted,
    });

    return {
      accepted,
      runId: input.runId,
      sessionId: run.sessionId,
      conversationId: run.conversationId,
    };
  }

  stopConversation(input: StopConversationInput): StopConversationResult {
    const matches = Array.from(this.runsByRunId.values()).filter(
      (run) => run.conversationId === input.conversationId,
    );
    const stopped: ActiveRunRecord[] = [];

    for (const run of matches) {
      const accepted = this.cancel.cancel(
        run.sessionId,
        input.reasonText ?? `stop requested by ${input.actor}`,
      );
      if (accepted) {
        stopped.push(run);
      }
    }

    logger.info("processed stop conversation request", {
      conversationId: input.conversationId,
      actor: input.actor,
      acceptedCount: stopped.length,
      runIds: stopped.map((run) => run.runId),
    });

    return {
      acceptedCount: stopped.length,
      conversationId: input.conversationId,
      runIds: stopped.map((run) => run.runId),
      sessionIds: stopped.map((run) => run.sessionId),
    };
  }
}
