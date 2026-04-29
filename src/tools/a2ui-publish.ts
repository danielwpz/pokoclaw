import { type Static, Type } from "@sinclair/typebox";

import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";

export interface A2uiPublisher {
  publish(input: {
    sessionId: string;
    conversationId: string;
    messages: unknown;
    ttlMs?: number;
  }): Promise<unknown>;
}

export const PUBLISH_A2UI_TOOL_SCHEMA = Type.Object(
  {
    messages: Type.Array(Type.Unknown(), {
      minItems: 1,
      description:
        "A2UI v0.8 runtime messages. Include surfaceUpdate/dataModelUpdate/beginRendering, and optionally dataSourceUpdate for dynamic content. Do not pass raw Lark card JSON.",
    }),
    ttlSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 300,
        description:
          "Optional lifetime for dynamic data sources. Static cards ignore this. Defaults to 60 seconds and is capped at 300 seconds.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type PublishA2uiToolArgs = Static<typeof PUBLISH_A2UI_TOOL_SCHEMA>;

export function createPublishA2uiTool(input: { publisher?: A2uiPublisher } = {}) {
  return defineTool({
    name: "publish_a2ui",
    description:
      "Validate A2UI v0.8 runtime messages with lark-a2ui-renderer, render them as a Feishu/Lark interactive card in the current chat, and route A2UI button callbacks back into this agent conversation. Use this when the user asks for an interactive UI, forms, choice flows, dashboards, or dynamic A2UI content. The tool accepts A2UI runtime JSON, not raw Lark CardKit JSON.",
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
        ...(args.ttlSeconds === undefined ? {} : { ttlMs: Math.trunc(args.ttlSeconds * 1000) }),
      });

      return jsonToolResult(result);
    },
  });
}
