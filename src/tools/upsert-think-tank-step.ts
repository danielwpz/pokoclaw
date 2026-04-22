import { type Static, Type } from "@sinclair/typebox";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
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

export const UPSERT_THINK_TANK_STEP_TOOL_SCHEMA = Type.Object(
  {
    key: Type.Optional(Type.String({ minLength: 1 })),
    kind: Type.Union([
      Type.Literal("participant_round"),
      Type.Literal("moderator_summary"),
      Type.Literal("final_summary"),
      Type.Literal("error"),
    ]),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("completed"),
      Type.Literal("failed"),
    ]),
    title: Type.Optional(Type.String({ minLength: 1 })),
    order: Type.Optional(Type.Integer({ minimum: 0 })),
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

export type UpsertThinkTankStepToolArgs = Static<typeof UPSERT_THINK_TANK_STEP_TOOL_SCHEMA>;

export function createUpsertThinkTankStepTool() {
  return defineTool({
    name: "upsert_think_tank_step",
    description:
      "Internal think tank tool. Persist a running episode step snapshot so channels can render progress before the episode finishes.",
    inputSchema: UPSERT_THINK_TANK_STEP_TOOL_SCHEMA,
    execute: async (context, args) => {
      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Think tank moderator session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "think_tank_moderator") {
        throw toolRecoverableError(
          "upsert_think_tank_step is only available inside think tank moderator sessions.",
          {
            code: "upsert_think_tank_step_wrong_session_purpose",
            sessionId: context.sessionId,
            sessionPurpose: session.purpose,
          },
        );
      }
      if (context.runtimeControl?.upsertThinkTankEpisodeStep == null) {
        throw toolInternalError(
          "upsert_think_tank_step is missing host runtime control to update episode progress.",
        );
      }
      const normalizedSummaryKind = normalizeSummaryKind(args.summaryKind);

      const updated = await context.runtimeControl.upsertThinkTankEpisodeStep({
        moderatorSessionId: context.sessionId,
        step: {
          ...(args.key === undefined ? {} : { key: args.key.trim() }),
          kind: args.kind,
          status: args.status,
          ...(args.title === undefined ? {} : { title: args.title.trim() }),
          ...(args.order === undefined ? {} : { order: args.order }),
          ...(args.roundIndex === undefined ? {} : { roundIndex: args.roundIndex }),
          ...(args.participantEntries === undefined
            ? {}
            : {
                participantEntries: args.participantEntries.map((entry) => ({
                  participantId: entry.participantId.trim(),
                  content: entry.content.trim(),
                })),
              }),
          ...(normalizedSummaryKind === undefined ? {} : { summaryKind: normalizedSummaryKind }),
          ...(args.summary === undefined
            ? {}
            : {
                summary: {
                  agreements: [...args.summary.agreements],
                  keyDifferences: [...args.summary.keyDifferences],
                  currentConclusion: args.summary.currentConclusion.trim(),
                  openQuestions: [...args.summary.openQuestions],
                },
              }),
          ...(args.errorMessage === undefined ? {} : { errorMessage: args.errorMessage.trim() }),
        },
      });

      return textToolResult("Recorded think tank step progress.", {
        thinkTankEpisodeStep: updated.step,
      });
    },
  });
}

function normalizeSummaryKind(value: string | undefined): "midpoint" | "final" | undefined {
  if (value === "midpoint" || value === "final") {
    return value;
  }
  return undefined;
}
