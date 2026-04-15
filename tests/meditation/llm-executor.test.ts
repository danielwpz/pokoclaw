import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import type { ResolvedModel } from "@/src/agent/llm/models.js";
import type { PiBridgeRunTurnResult } from "@/src/agent/llm/pi-bridge.js";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import {
  MeditationSubmitLoopError,
  runMeditationSubmitLoop,
} from "@/src/meditation/llm-executor.js";
import {
  type BucketMeditationSubmit,
  createBucketSubmitTool,
} from "@/src/meditation/submit-tools.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

function createModel(): ResolvedModel {
  return {
    id: "openai_main/gpt-5-mini",
    providerId: "openai_main",
    upstreamId: "gpt-5-mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: false,
    reasoning: { enabled: true },
    provider: {
      id: "openai_main",
      api: "openai-responses",
      apiKey: "test-key",
    },
  };
}

function createSubmitResult(args: Record<string, unknown>): PiBridgeRunTurnResult {
  return {
    provider: "openai_main",
    model: "gpt-5-mini",
    modelApi: "openai-responses",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "tool_1",
        name: "submit",
        arguments: args,
      },
    ],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}

describe("runMeditationSubmitLoop", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("returns immediately when the first turn submits valid arguments", async () => {
    handle = await createTestDatabase(import.meta.url);
    const calls: string[] = [];
    let submitted: BucketMeditationSubmit | null = null;

    const result = await runMeditationSubmitLoop<BucketMeditationSubmit>({
      bridge: {
        async completeTurn(input) {
          calls.push(input.messages.at(-1)?.payloadJson ?? "");
          return createSubmitResult({
            note: "Strong recurring permission friction.",
            findings: [
              {
                summary:
                  "Repeated protected-path reads suggest earlier narrow permission requests.",
                issue_type: "user_preference_signal",
                scope_hint: "shared",
                cluster_ids: ["tool_repeat:1"],
                evidence_summary: "The same permission-denied pattern repeated in one session.",
                examples: ["tool error: Permission request denied."],
              },
            ],
          });
        },
      },
      model: createModel(),
      prompt: "bucket prompt",
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      tools: [
        createBucketSubmitTool((payload) => {
          submitted = payload;
        }),
      ],
      getSubmission: () => submitted,
    });

    expect(calls).toHaveLength(1);
    expect(submitted).toEqual({
      note: "Strong recurring permission friction.",
      findings: [
        {
          summary: "Repeated protected-path reads suggest earlier narrow permission requests.",
          issue_type: "user_preference_signal",
          scope_hint: "shared",
          cluster_ids: ["tool_repeat:1"],
          evidence_summary: "The same permission-denied pattern repeated in one session.",
          examples: ["tool error: Permission request denied."],
        },
      ],
    });
    expect(result.submission).toEqual(submitted);
    expect(result.turns).toHaveLength(1);
  });

  test("adds a reminder turn when the model answers without calling submit", async () => {
    handle = await createTestDatabase(import.meta.url);
    const calls: string[] = [];
    let submitted: BucketMeditationSubmit | null = null;
    let invocation = 0;

    const result = await runMeditationSubmitLoop<BucketMeditationSubmit>({
      bridge: {
        async completeTurn(input) {
          invocation += 1;
          calls.push(input.messages.at(-1)?.payloadJson ?? "");
          if (invocation === 1) {
            return {
              provider: "openai_main",
              model: "gpt-5-mini",
              modelApi: "openai-responses",
              stopReason: "stop",
              content: [{ type: "text", text: "Here is my analysis, but I forgot the tool." }],
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            };
          }

          return createSubmitResult({
            note: "Recovered on second turn.",
            findings: [],
          });
        },
      },
      model: createModel(),
      prompt: "bucket prompt",
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      tools: [
        createBucketSubmitTool((payload) => {
          submitted = payload;
        }),
      ],
      getSubmission: () => submitted,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("You must call the submit tool");
    expect(submitted).toEqual({
      note: "Recovered on second turn.",
      findings: [],
    });
    expect(result.turns).toHaveLength(2);
  });

  test("retries after invalid submit args produce a tool-result error", async () => {
    handle = await createTestDatabase(import.meta.url);
    const calls: string[] = [];
    let submitted: BucketMeditationSubmit | null = null;
    let invocation = 0;

    const result = await runMeditationSubmitLoop<BucketMeditationSubmit>({
      bridge: {
        async completeTurn(input) {
          invocation += 1;
          calls.push(input.messages.at(-1)?.payloadJson ?? "");
          if (invocation === 1) {
            return createSubmitResult({
              note: 123,
              findings: [],
            });
          }

          return createSubmitResult({
            note: "Valid after tool validation error.",
            findings: [],
          });
        },
      },
      model: createModel(),
      prompt: "bucket prompt",
      storage: handle.storage.db,
      securityConfig: DEFAULT_CONFIG.security,
      tools: [
        createBucketSubmitTool((payload) => {
          submitted = payload;
        }),
      ],
      getSubmission: () => submitted,
    });

    expect(submitted).toEqual({
      note: "Valid after tool validation error.",
      findings: [],
    });
    expect(result.turns).toHaveLength(2);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("fails after exhausting the max turn budget without a valid submit", async () => {
    handle = await createTestDatabase(import.meta.url);

    await expect(
      runMeditationSubmitLoop({
        bridge: {
          async completeTurn() {
            return {
              provider: "openai_main",
              model: "gpt-5-mini",
              modelApi: "openai-responses",
              stopReason: "stop",
              content: [{ type: "text", text: "still no submit" }],
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            };
          },
        },
        model: createModel(),
        prompt: "bucket prompt",
        storage: handle.storage.db,
        securityConfig: DEFAULT_CONFIG.security,
        getSubmission: () => null,
        tools: [
          {
            name: "submit",
            description: "submit",
            inputSchema: Type.Object(
              {
                note: Type.String(),
                findings: Type.Array(
                  Type.Object(
                    {
                      summary: Type.String(),
                      issue_type: Type.String(),
                      scope_hint: Type.String(),
                      cluster_ids: Type.Array(Type.String()),
                      evidence_summary: Type.String(),
                      examples: Type.Array(Type.String()),
                    },
                    { additionalProperties: false },
                  ),
                ),
              },
              { additionalProperties: false },
            ),
            execute() {
              return {
                content: [{ type: "text", text: "unused" }],
              };
            },
          },
        ],
        maxTurns: 2,
      }),
    ).rejects.toBeInstanceOf(MeditationSubmitLoopError);
  });
});
