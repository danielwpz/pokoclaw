import { type Static, Type } from "@sinclair/typebox";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

const CONSULT_PARTICIPANT_STEP_HINT_SCHEMA = Type.Object(
  {
    key: Type.Optional(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    order: Type.Optional(Type.Integer({ minimum: 0 })),
    roundIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const CONSULT_PARTICIPANT_TOOL_SCHEMA = Type.Object(
  {
    participantId: Type.String({
      minLength: 1,
      description: "Stable participant id chosen when the consultation was created.",
    }),
    prompt: Type.String({
      minLength: 1,
      description: "The exact prompt to send to this participant for the current step.",
    }),
    step: Type.Optional(CONSULT_PARTICIPANT_STEP_HINT_SCHEMA),
  },
  { additionalProperties: false },
);

export type ConsultParticipantToolArgs = Static<typeof CONSULT_PARTICIPANT_TOOL_SCHEMA>;

export function createConsultParticipantTool() {
  return defineTool({
    name: "consult_participant",
    description:
      "Internal think tank tool. Send one prompt to one participant in the current consultation and wait for that participant's reply.",
    inputSchema: CONSULT_PARTICIPANT_TOOL_SCHEMA,
    getInvocationTimeoutMs: () => 60_000,
    execute: async (context, args) => {
      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Think tank moderator session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "think_tank_moderator") {
        throw toolRecoverableError(
          "consult_participant is only available inside think tank moderator sessions.",
          {
            code: "consult_participant_wrong_session_purpose",
            sessionId: context.sessionId,
            sessionPurpose: session.purpose,
          },
        );
      }
      if (context.runtimeControl?.consultThinkTankParticipant == null) {
        throw toolInternalError(
          "consult_participant is missing host runtime control to reach participant sessions.",
        );
      }

      const consulted = await context.runtimeControl.consultThinkTankParticipant({
        moderatorSessionId: context.sessionId,
        participantId: args.participantId.trim(),
        prompt: args.prompt.trim(),
        ...(args.step === undefined
          ? {}
          : {
              step: {
                ...(args.step.key === undefined ? {} : { key: args.step.key.trim() }),
                ...(args.step.title === undefined ? {} : { title: args.step.title.trim() }),
                ...(args.step.order === undefined ? {} : { order: args.step.order }),
                ...(args.step.roundIndex === undefined ? {} : { roundIndex: args.step.roundIndex }),
              },
            }),
      });

      return textToolResult(consulted.reply, {
        thinkTankParticipantConsultation: consulted,
      });
    },
  });
}
