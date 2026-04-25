import { type Static, Type } from "@sinclair/typebox";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import {
  THINK_TANK_EPISODE_COMPLETION_TOOL_NAME,
  type ThinkTankEpisodeCompletionDetails,
} from "@/src/think-tank/episode-completion.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

const THINK_TANK_SUMMARY_SCHEMA = Type.Object(
  {
    agreements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    keyDifferences: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    currentConclusion: Type.String({ minLength: 1 }),
    openQuestions: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const THINK_TANK_PARTICIPANT_ENTRY_SCHEMA = Type.Object(
  {
    participantId: Type.String({ minLength: 1 }),
    content: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const THINK_TANK_STEP_SCHEMA = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("participant_round"),
      Type.Literal("moderator_summary"),
      Type.Literal("final_summary"),
      Type.Literal("error"),
    ]),
    title: Type.String({ minLength: 1 }),
    order: Type.Integer({ minimum: 0 }),
    roundIndex: Type.Optional(Type.Integer({ minimum: 1 })),
    participantEntries: Type.Optional(
      Type.Array(THINK_TANK_PARTICIPANT_ENTRY_SCHEMA, {
        minItems: 1,
      }),
    ),
    summaryKind: Type.Optional(Type.String({ minLength: 1 })),
    summary: Type.Optional(THINK_TANK_SUMMARY_SCHEMA),
    errorMessage: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const FINISH_THINK_TANK_EPISODE_TOOL_SCHEMA = Type.Object(
  {
    summary: THINK_TANK_SUMMARY_SCHEMA,
    steps: Type.Array(THINK_TANK_STEP_SCHEMA, {
      minItems: 1,
      description:
        "Semantic episode steps in display order. Include participant rounds and moderator summary steps that should appear in channel renderers.",
    }),
  },
  { additionalProperties: false },
);

export type FinishThinkTankEpisodeToolArgs = Static<typeof FINISH_THINK_TANK_EPISODE_TOOL_SCHEMA>;

export function createFinishThinkTankEpisodeTool() {
  return defineTool({
    name: THINK_TANK_EPISODE_COMPLETION_TOOL_NAME,
    description:
      "Internal think tank tool. Submit the structured result of the current episode and stop the moderator run.",
    inputSchema: FINISH_THINK_TANK_EPISODE_TOOL_SCHEMA,
    execute: (context, args) => {
      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Think tank moderator session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "think_tank_moderator") {
        throw toolRecoverableError(
          "finish_think_tank_episode is only available inside think tank moderator sessions.",
          {
            code: "finish_think_tank_episode_wrong_session_purpose",
            sessionId: context.sessionId,
            sessionPurpose: session.purpose,
          },
        );
      }

      const details: ThinkTankEpisodeCompletionDetails = {
        thinkTankEpisodeCompletion: {
          summary: {
            agreements: [...args.summary.agreements],
            keyDifferences: [...args.summary.keyDifferences],
            currentConclusion: args.summary.currentConclusion.trim(),
            openQuestions: [...args.summary.openQuestions],
          },
          steps: args.steps.map((step) => {
            const normalizedSummaryKind = normalizeSummaryKind(step.summaryKind);
            return {
              key: step.key.trim(),
              kind: step.kind,
              title: step.title.trim(),
              order: step.order,
              ...(step.roundIndex === undefined ? {} : { roundIndex: step.roundIndex }),
              ...(step.participantEntries === undefined
                ? {}
                : {
                    participantEntries: step.participantEntries.map((entry) => ({
                      participantId: entry.participantId.trim(),
                      content: entry.content.trim(),
                    })),
                  }),
              ...(normalizedSummaryKind === undefined
                ? {}
                : { summaryKind: normalizedSummaryKind }),
              ...(step.summary === undefined
                ? {}
                : {
                    summary: {
                      agreements: [...step.summary.agreements],
                      keyDifferences: [...step.summary.keyDifferences],
                      currentConclusion: step.summary.currentConclusion.trim(),
                      openQuestions: [...step.summary.openQuestions],
                    },
                  }),
              ...(step.errorMessage === undefined
                ? {}
                : { errorMessage: step.errorMessage.trim() }),
            };
          }),
        },
      };

      return textToolResult("Recorded think tank episode completion.", details);
    },
  });
}

function normalizeSummaryKind(value: string | undefined): "midpoint" | "final" | undefined {
  if (value === "midpoint" || value === "final") {
    return value;
  }
  return undefined;
}
