import { type Static, Type } from "@sinclair/typebox";

import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { resolveThinkTankCaller } from "@/src/tools/helpers/think-tank.js";

export const GET_THINK_TANK_STATUS_TOOL_SCHEMA = Type.Object(
  {
    consultationId: Type.String({
      minLength: 1,
      description: "Consultation id returned by consult_think_tank.",
    }),
  },
  { additionalProperties: false },
);

export type GetThinkTankStatusToolArgs = Static<typeof GET_THINK_TANK_STATUS_TOOL_SCHEMA>;

export function createGetThinkTankStatusTool() {
  return defineTool({
    name: "get_think_tank_status",
    description:
      "Inspect one think tank consultation and retrieve its latest known status and synthesis.",
    inputSchema: GET_THINK_TANK_STATUS_TOOL_SCHEMA,
    async execute(context, args) {
      resolveThinkTankCaller(context);

      if (context.runtimeControl?.getThinkTankStatus == null) {
        throw toolInternalError(
          "get_think_tank_status is missing host runtime control to inspect think tank state.",
        );
      }

      const status = await context.runtimeControl.getThinkTankStatus({
        sourceSessionId: context.sessionId,
        consultationId: args.consultationId,
      });
      if (status == null) {
        throw toolRecoverableError(
          `Think tank consultation "${args.consultationId}" was not found for this chat.`,
          {
            code: "think_tank_not_found",
            consultationId: args.consultationId,
          },
        );
      }

      return jsonToolResult(status, status);
    },
  });
}
