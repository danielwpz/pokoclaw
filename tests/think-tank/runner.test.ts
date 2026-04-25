import { describe, expect, test } from "vitest";

import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { RunAgentLoopResult } from "@/src/agent/loop.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { ThinkTankEpisodeRunner } from "@/src/think-tank/runner.js";

function makeRun(input: { sessionId: string; scenario: ModelScenario }): RunAgentLoopResult {
  return {
    runId: `run_${input.sessionId}`,
    sessionId: input.sessionId,
    scenario: input.scenario,
    modelId: "test-model",
    appendedMessageIds: [],
    toolExecutions: 0,
    compaction: {
      shouldCompact: false,
      reason: null,
      thresholdTokens: 1000,
      effectiveWindow: 2000,
    },
    events: [],
    stopSignal: null,
  };
}

describe("ThinkTankEpisodeRunner", () => {
  test("caps excessive moderator pass settings", async () => {
    const submitted: SubmitMessageInput[] = [];
    const runner = new ThinkTankEpisodeRunner({
      maxModeratorPasses: Infinity,
      ingress: {
        submitMessage: async (input): Promise<SubmitMessageResult> => {
          submitted.push(input);
          return {
            status: "started",
            messageId: `msg_${submitted.length}`,
            run: makeRun({
              sessionId: input.sessionId,
              scenario: input.scenario,
            }),
          };
        },
      },
    });

    const result = await runner.runEpisode({
      moderatorSessionId: "sess_moderator",
      moderatorModelId: "codex-gpt5.4",
      consultationId: "tt_1",
      episodeId: "ep_1",
      episodeSequence: 1,
      episodePrompt: "Run the episode.",
    });

    if (result.status !== "failed") {
      throw new Error(`Expected failed result, received ${result.status}`);
    }

    expect(submitted).toHaveLength(10);
    expect(result.errorMessage).toContain("after 10 passes");
    expect(submitted[submitted.length - 1]?.content).toContain("<max_passes>10</max_passes>");
  });
});
