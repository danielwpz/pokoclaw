import { Type } from "@sinclair/typebox";

import { toolInternalError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { resolveThinkTankCaller } from "@/src/tools/helpers/think-tank.js";

export const GET_THINK_TANK_CAPABILITIES_TOOL_SCHEMA = Type.Object(
  {},
  { additionalProperties: false },
);

export function createGetThinkTankCapabilitiesTool() {
  return defineTool({
    name: "get_think_tank_capabilities",
    description:
      "List available think tank advisor models and consultation size limits. Use this before creating a think tank when you need to know which models are currently allowed.",
    inputSchema: GET_THINK_TANK_CAPABILITIES_TOOL_SCHEMA,
    async execute(context) {
      resolveThinkTankCaller(context);

      if (context.runtimeControl?.getThinkTankCapabilities == null) {
        throw toolInternalError(
          "get_think_tank_capabilities is missing host runtime control to read think tank capabilities.",
        );
      }

      const capabilities = await context.runtimeControl.getThinkTankCapabilities({
        sourceSessionId: context.sessionId,
      });
      return jsonToolResult(capabilities, capabilities);
    },
  });
}
