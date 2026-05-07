import { type Static, Type } from "@sinclair/typebox";

import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";

export interface A2uiPublisher {
  publish(input: {
    sessionId: string;
    conversationId: string;
    messages: unknown;
  }): Promise<unknown>;
}

export const PUBLISH_A2UI_TOOL_SCHEMA = Type.Object(
  {
    messages: Type.Array(Type.Unknown(), {
      minItems: 1,
      description:
        "A2UI v0.8 runtime messages. Include surfaceUpdate/dataModelUpdate/beginRendering. Pokoclaw A2UI 1.0 does not support dataSourceUpdate or dynamic content. Do not pass raw channel card JSON.",
    }),
  },
  { additionalProperties: false },
);

export type PublishA2uiToolArgs = Static<typeof PUBLISH_A2UI_TOOL_SCHEMA>;

export function createPublishA2uiTool(input: { publisher?: A2uiPublisher } = {}) {
  return defineTool({
    name: "publish_a2ui",
    description:
      "Validate A2UI v0.8 runtime messages, render them as an interactive surface in the current channel, and route A2UI callbacks back into this agent conversation. Use this when the user asks for an interactive UI, forms, choice flows, or dashboards. The tool accepts static A2UI runtime JSON, not raw channel card JSON or dynamic data sources.",
    inputSchema: PUBLISH_A2UI_TOOL_SCHEMA,
    async execute(context, args) {
      if (input.publisher == null) {
        throw toolInternalError("publish_a2ui is not configured in this runtime.");
      }

      const session = new SessionsRepo(context.storage).getById(context.sessionId);
      if (session == null) {
        throw toolInternalError(`Source session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "chat") {
        throw toolRecoverableError("publish_a2ui is only available in chat sessions.", {
          code: "publish_a2ui_wrong_session_purpose",
          sessionPurpose: session.purpose,
        });
      }

      const result = await input.publisher.publish({
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        messages: args.messages,
      });

      return jsonToolResult(result);
    },
  });
}
