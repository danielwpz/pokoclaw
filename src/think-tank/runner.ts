import type { RunAgentLoopResult } from "@/src/agent/loop.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import {
  extractThinkTankEpisodeCompletionSignal,
  THINK_TANK_EPISODE_COMPLETION_TOOL_NAME,
  type ThinkTankEpisodeCompletionSignal,
} from "@/src/think-tank/episode-completion.js";
import {
  buildThinkTankEpisodeKickoffEnvelope,
  buildThinkTankEpisodeSupervisorReminderEnvelope,
} from "@/src/think-tank/session-runtime.js";

const logger = createSubsystemLogger("think-tank/runner");
const DEFAULT_MAX_MODERATOR_PASSES = 3;

export interface ThinkTankEpisodeRunnerIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
}

export interface ThinkTankEpisodeRunnerDependencies {
  ingress: ThinkTankEpisodeRunnerIngress;
  maxModeratorPasses?: number;
}

export type ThinkTankEpisodeRunResult =
  | {
      status: "completed";
      started: Extract<SubmitMessageResult, { status: "started" }>;
      run: RunAgentLoopResult;
      completion: ThinkTankEpisodeCompletionSignal;
    }
  | {
      status: "failed";
      errorMessage: string;
    }
  | {
      status: "cancelled";
      errorMessage: string;
    };

export class ThinkTankEpisodeRunner {
  private readonly maxModeratorPasses: number;

  constructor(private readonly deps: ThinkTankEpisodeRunnerDependencies) {
    this.maxModeratorPasses = Math.max(1, deps.maxModeratorPasses ?? DEFAULT_MAX_MODERATOR_PASSES);
  }

  async runEpisode(input: {
    moderatorSessionId: string;
    moderatorModelId: string;
    consultationId: string;
    episodeId: string;
    episodeSequence: number;
    episodePrompt: string;
    latestConclusion?: string | null;
    createdAt?: Date;
  }): Promise<ThinkTankEpisodeRunResult> {
    try {
      for (let pass = 1; pass <= this.maxModeratorPasses; pass += 1) {
        const started = await this.submitModeratorPass({
          ...input,
          pass,
          ...(pass === 1 && input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        });

        if (started.status !== "started") {
          return {
            status: "failed",
            errorMessage: "Think tank moderator session was already active before the episode run.",
          };
        }

        const completion = extractThinkTankEpisodeCompletionFromRun(started.run);
        if (completion != null) {
          return {
            status: "completed",
            started,
            run: started.run,
            completion,
          };
        }

        logger.warn("think tank moderator pass ended without finish_think_tank_episode", {
          consultationId: input.consultationId,
          episodeId: input.episodeId,
          episodeSequence: input.episodeSequence,
          pass,
          maxModeratorPasses: this.maxModeratorPasses,
        });
      }

      return {
        status: "failed",
        errorMessage: `Think tank moderator ended without calling ${THINK_TANK_EPISODE_COMPLETION_TOOL_NAME} after ${this.maxModeratorPasses} passes.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\babort|cancel/i.test(message)) {
        return {
          status: "cancelled",
          errorMessage: message,
        };
      }
      return {
        status: "failed",
        errorMessage: message,
      };
    }
  }

  private async submitModeratorPass(input: {
    moderatorSessionId: string;
    moderatorModelId: string;
    consultationId: string;
    episodeId: string;
    episodeSequence: number;
    episodePrompt: string;
    latestConclusion?: string | null;
    pass: number;
    createdAt?: Date;
  }): Promise<SubmitMessageResult> {
    const content =
      input.pass === 1
        ? buildThinkTankEpisodeKickoffEnvelope({
            consultationId: input.consultationId,
            episodeId: input.episodeId,
            episodeSequence: input.episodeSequence,
            episodePrompt: input.episodePrompt,
            ...(input.latestConclusion == null ? {} : { latestConclusion: input.latestConclusion }),
          })
        : buildThinkTankEpisodeSupervisorReminderEnvelope({
            episodeSequence: input.episodeSequence,
            nextPass: input.pass,
            maxPasses: this.maxModeratorPasses,
          });

    const messageInput: SubmitMessageInput = {
      sessionId: input.moderatorSessionId,
      scenario: "chat",
      modelIdOverride: input.moderatorModelId,
      content,
      messageType:
        input.pass === 1 ? "think_tank_episode_kickoff" : "think_tank_supervisor_followup",
      visibility: "hidden_system",
      afterToolResultHook: {
        afterToolResult: ({ toolCall, result }) => {
          const completion = extractThinkTankEpisodeCompletionSignal({
            toolName: toolCall.name,
            result,
          });
          if (completion == null) {
            return { kind: "continue" };
          }
          return {
            kind: "stop_run",
            reason: "think_tank_episode_completion",
            payload: {
              thinkTankEpisodeCompletion: completion,
            },
          };
        },
      },
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    };

    logger.debug("submitting think tank moderator pass", {
      consultationId: input.consultationId,
      episodeId: input.episodeId,
      episodeSequence: input.episodeSequence,
      pass: input.pass,
      modelIdOverride: input.moderatorModelId,
    });

    return this.deps.ingress.submitMessage(messageInput);
  }
}

function extractThinkTankEpisodeCompletionFromRun(
  run: RunAgentLoopResult,
): ThinkTankEpisodeCompletionSignal | null {
  const payload =
    run.stopSignal?.reason === "think_tank_episode_completion" && run.stopSignal.payload != null
      ? (run.stopSignal.payload as { thinkTankEpisodeCompletion?: unknown })
          .thinkTankEpisodeCompletion
      : undefined;
  return extractThinkTankEpisodeCompletionSignal({
    details: payload == null ? undefined : { thinkTankEpisodeCompletion: payload },
  });
}
