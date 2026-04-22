import { type Static, Type } from "@sinclair/typebox";

import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { resolveThinkTankCaller } from "@/src/tools/helpers/think-tank.js";

const THINK_TANK_PARTICIPANT_SCHEMA = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description:
        "Stable participant identifier for this consultation. Use protocol-friendly ids such as `product_lead` or `infra_engineer`.",
    }),
    model: Type.String({
      minLength: 1,
      description:
        "Exact think tank model id to use for this participant. Must be one of the currently available think tank advisor models.",
    }),
    persona: Type.String({
      minLength: 1,
      description:
        "Rich persona/background text for this participant. Include their lens, priorities, and what they care about most.",
    }),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional display title for channel renderers.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const CONSULT_THINK_TANK_TOOL_SCHEMA = Type.Object(
  {
    topic: Type.String({
      minLength: 1,
      description: "Core question or decision the think tank should analyze.",
    }),
    context: Type.String({
      minLength: 1,
      description:
        "A caller-prepared context packet. Include enough background, constraints, and current hypotheses for advisors to reason well without access to raw chat history.",
    }),
    participants: Type.Array(THINK_TANK_PARTICIPANT_SCHEMA, {
      minItems: 2,
      maxItems: 4,
      description:
        "The explicit participant set for this consultation. Each participant locks one advisor model plus its persona for all later follow-up episodes.",
    }),
  },
  { additionalProperties: false },
);

export type ConsultThinkTankToolArgs = Static<typeof CONSULT_THINK_TANK_TOOL_SCHEMA>;

export function createConsultThinkTankTool() {
  return defineTool({
    name: "consult_think_tank",
    description:
      "Start an asynchronous think tank consultation attached to this chat. The caller defines the participant set explicitly with stable ids, models, and personas.",
    inputSchema: CONSULT_THINK_TANK_TOOL_SCHEMA,
    async execute(context, args) {
      const caller = resolveThinkTankCaller(context);

      if (context.currentModelId == null || context.currentModelId.length === 0) {
        throw toolInternalError(
          "consult_think_tank requires the current moderator model id in tool execution context.",
        );
      }
      if (context.runtimeControl?.startThinkTankConsultation == null) {
        throw toolInternalError(
          "consult_think_tank is missing host runtime control to start a consultation.",
        );
      }

      const uniqueIds = new Set(args.participants.map((participant) => participant.id));
      if (uniqueIds.size !== args.participants.length) {
        throw toolRecoverableError(
          "consult_think_tank participants must use unique `id` values within one consultation.",
          {
            code: "think_tank_duplicate_participant_ids",
          },
        );
      }

      const started = await context.runtimeControl.startThinkTankConsultation({
        sourceSessionId: context.sessionId,
        sourceConversationId: caller.session.conversationId,
        sourceBranchId: caller.session.branchId,
        ownerAgentId: caller.session.ownerAgentId,
        moderatorModelId: context.currentModelId,
        topic: args.topic.trim(),
        context: args.context.trim(),
        participants: args.participants.map((participant) => ({
          id: participant.id,
          model: participant.model,
          persona: participant.persona,
          title: participant.title ?? null,
        })),
      });

      return {
        ...jsonToolResult(started, started),
        control: {
          stopRun: {
            reason: "think_tank_consultation_started",
            payload: {
              consultationId: started.consultationId,
            },
          },
        },
      };
    },
  });
}
