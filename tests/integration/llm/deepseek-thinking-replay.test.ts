import { Type } from "@sinclair/typebox";
import { describe, expect, test } from "vitest";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import { PiBridge } from "@/src/agent/llm/pi-bridge.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool } from "@/src/tools/core/types.js";
import {
  createStoredAssistantMessage,
  createStoredToolResultMessage,
  createStoredUserMessage,
  getIntegerIntegrationEnv,
  getRequiredIntegrationEnv,
  loadIntegrationEnvFile,
} from "@/tests/integration/llm/helpers/fixture.js";

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });

describe("DeepSeek thinking replay integration", () => {
  test("continues legacy tool-call history that has no stored reasoning_content", async () => {
    const profile = await loadRequiredDeepSeekProfile();
    const model = createDeepSeekModel(profile);
    const bridge = new PiBridge();

    const result = await bridge.completeTurn({
      model,
      compactSummary: null,
      messages: [
        createStoredUserMessage({
          sessionId: "sess_deepseek_legacy_replay",
          id: "msg_user_1",
          seq: 1,
          content: "Use get_date before answering.",
          createdAt: "2026-04-26T00:00:01.000Z",
        }),
        createStoredAssistantMessage({
          sessionId: "sess_deepseek_legacy_replay",
          id: "msg_assistant_1",
          seq: 2,
          createdAt: "2026-04-26T00:00:02.000Z",
          provider: model.provider.id,
          model: model.upstreamId,
          modelApi: model.provider.api,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_date",
              name: "get_date",
              arguments: {},
            },
          ],
        }),
        createStoredToolResultMessage({
          sessionId: "sess_deepseek_legacy_replay",
          id: "msg_tool_1",
          seq: 3,
          createdAt: "2026-04-26T00:00:03.000Z",
          toolCallId: "call_date",
          toolName: "get_date",
          content: [{ type: "text", text: "2026-04-26" }],
        }),
        createStoredUserMessage({
          sessionId: "sess_deepseek_legacy_replay",
          id: "msg_user_2",
          seq: 4,
          content: "Continue from the tool result. Include the token POKOCLAW_DEEPSEEK_REPLAY_OK.",
          createdAt: "2026-04-26T00:00:04.000Z",
        }),
      ],
      tools: new ToolRegistry([
        defineTool({
          name: "get_date",
          description: "Get the current date.",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return { content: [{ type: "text", text: "2026-04-26" }] };
          },
        }),
      ]),
      signal: new AbortController().signal,
    });

    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(hasAssistantOutput(result.content)).toBe(true);

    const responseText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(responseText).toContain("POKOCLAW_DEEPSEEK_REPLAY_OK");
  }, 60_000);
});

interface DeepSeekIntegrationProfile {
  apiKey: string;
  baseUrl: string;
  upstreamId: string;
  contextWindow: number;
  maxOutputTokens: number;
}

async function loadRequiredDeepSeekProfile(): Promise<DeepSeekIntegrationProfile> {
  const env = await loadIntegrationEnvFile();
  return {
    apiKey: getRequiredIntegrationEnv(env, "POKOCLAW_IT_DEEPSEEK_API_KEY"),
    baseUrl: getRequiredIntegrationEnv(env, "POKOCLAW_IT_DEEPSEEK_BASE_URL"),
    upstreamId: getRequiredIntegrationEnv(env, "POKOCLAW_IT_DEEPSEEK_UPSTREAM_ID"),
    contextWindow: getIntegerIntegrationEnv(env, "POKOCLAW_IT_DEEPSEEK_CONTEXT_WINDOW", 200_000),
    maxOutputTokens: getIntegerIntegrationEnv(
      env,
      "POKOCLAW_IT_DEEPSEEK_MAX_OUTPUT_TOKENS",
      32_000,
    ),
  };
}

function createDeepSeekModel(profile: DeepSeekIntegrationProfile): ResolvedModel {
  return {
    id: "deepseek-integration",
    providerId: "deepseek",
    upstreamId: profile.upstreamId,
    contextWindow: profile.contextWindow,
    maxOutputTokens: profile.maxOutputTokens,
    supportsTools: true,
    supportsVision: false,
    reasoning: { enabled: true, effort: "high" },
    provider: {
      id: "deepseek",
      api: "openai-completions",
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
    },
  };
}

function hasAssistantOutput(content: Array<{ type: string }>): boolean {
  return content.some((block) => {
    if (block.type === "text") {
      return typeof (block as { text?: unknown }).text === "string";
    }
    if (block.type === "toolCall") {
      return true;
    }
    return false;
  });
}
