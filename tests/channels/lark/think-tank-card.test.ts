import { describe, expect, test } from "vitest";

import {
  buildLarkRenderedThinkTankEpisodeCard,
  buildLarkRenderedThinkTankMainCard,
  buildLarkRenderedThinkTankStepCard,
} from "@/src/channels/lark/render/think-tank-card.js";
import type { LarkThinkTankConsultationState } from "@/src/channels/lark/think-tank-state.js";

function makeConsultationState(): LarkThinkTankConsultationState {
  return {
    consultationId: "tt_1",
    conversationId: "conv_1",
    branchId: "branch_1",
    topic: "如何增强 Agent 的自我长期运行能力？",
    status: "running",
    participants: [
      {
        id: "runtime_engineer",
        title: "高级 Agent 研发工程师",
        model: "openrouter-claude-sonnet-4",
      },
      {
        id: "product_manager",
        title: "产品经理",
        model: "openrouter-gemini-3.1-flash",
      },
    ],
    latestSummary: {
      agreements: ["需要更强的恢复能力。", "需要更好的过程可见性。"],
      keyDifferences: ["产品更强调托付感，工程更强调恢复和边界。"],
      currentConclusion: "先把恢复能力和过程可见性一起做起来。",
      openQuestions: ["什么情况下允许完全无人值守？"],
    },
    firstCompleted: true,
    episodes: new Map(),
  };
}

describe("lark think tank cards", () => {
  test("renders the main card with demo-style subtitle, participants, and latest synthesis", () => {
    const rendered = buildLarkRenderedThinkTankMainCard(makeConsultationState());
    const card = rendered.card as {
      header?: { title?: { content?: string }; subtitle?: { content?: string }; template?: string };
    };
    const text = JSON.stringify(rendered.card);

    expect(card.header?.title?.content).toBe("智囊团 · 已完成");
    expect(card.header?.subtitle?.content).toBe("智囊团圆桌讨论");
    expect(card.header?.template).toBe("green");
    expect(text).toContain("高级 Agent 研发工程师");
    expect(text).toContain("产品经理");
    expect(text).toContain("🤝 Agreements");
    expect(text).toContain("⚡ Key Differences");
    expect(text).toContain("🎯 Current Conclusion");
  });

  test("renders an episode placeholder card immediately when a round starts", () => {
    const rendered = buildLarkRenderedThinkTankEpisodeCard({
      consultation: makeConsultationState(),
      episode: {
        episodeId: "ep_1",
        episodeSequence: 1,
        prompt: "先讨论长期运行最关键的能力。",
        status: "running",
        plannedSteps: null,
        steps: new Map(),
      },
    });
    const card = rendered.card as {
      header?: { title?: { content?: string }; template?: string };
    };
    const text = JSON.stringify(rendered.card);

    expect(card.header?.title?.content).toBe("第 1 轮讨论中");
    expect(card.header?.template).toBe("blue");
    expect(text).toContain("主持人已启动本轮讨论");
  });

  test("renders a participant round as demo-style collapsible expert sections", () => {
    const rendered = buildLarkRenderedThinkTankStepCard({
      consultation: makeConsultationState(),
      step: {
        key: "round_1",
        kind: "participant_round",
        title: "Round 1 · 独立观点",
        order: 10,
        status: "completed",
        participantRound: {
          roundIndex: 1,
          entries: [
            {
              participantId: "runtime_engineer",
              title: "高级 Agent 研发工程师",
              model: "openrouter-claude-sonnet-4",
              preview: "先解决恢复能力和故",
              content: "先解决恢复能力和故障边界，否则长期运行不可托付。",
            },
            {
              participantId: "product_manager",
              title: "产品经理",
              model: "openrouter-gemini-3.1-flash",
              preview: "还需要把过程做得更",
              content: "还需要把过程做得更可见，否则用户不敢真正托付。",
            },
          ],
        },
      },
    });

    const card = rendered.card as { header?: { template?: string } };
    const text = JSON.stringify(rendered.card);
    expect(card.header?.template).toBe("blue");
    expect(text).toContain("专家 A");
    expect(text).toContain("专家 B");
    expect(text).toContain("collapsible_panel");
  });

  test("renders midpoint synthesis with separate collapsible summary blocks", () => {
    const rendered = buildLarkRenderedThinkTankStepCard({
      consultation: makeConsultationState(),
      step: {
        key: "midpoint",
        kind: "moderator_summary",
        title: "Moderator Synthesis · 第一次汇总",
        order: 20,
        status: "completed",
        moderatorSummary: {
          summaryKind: "midpoint",
          summary: {
            agreements: ["长期运行必须有恢复能力。"],
            keyDifferences: ["产品更关注托付感，工程更关注边界。"],
            currentConclusion: "先同时补恢复和过程可见性。",
            openQuestions: ["多大程度上允许无人值守？"],
          },
        },
      },
    });

    const card = rendered.card as { header?: { template?: string } };
    const text = JSON.stringify(rendered.card);
    expect(card.header?.template).toBe("carmine");
    expect(text).toContain("🤝 Agreements");
    expect(text).toContain("⚡ Key Differences");
    expect(text).toContain("🕳 Open Questions");
    expect(text).toContain("collapsible_panel");
  });

  test("renders final synthesis as expanded blocks instead of collapsible panels", () => {
    const rendered = buildLarkRenderedThinkTankStepCard({
      consultation: makeConsultationState(),
      step: {
        key: "final",
        kind: "final_summary",
        title: "Current Conclusion",
        order: 40,
        status: "completed",
        moderatorSummary: {
          summaryKind: "final",
          summary: {
            agreements: ["要先做恢复和可见性。"],
            keyDifferences: ["产品和工程对优先级顺序略有不同。"],
            currentConclusion: "当前建议是先做恢复能力、再把过程展示清楚。",
            openQuestions: ["是否默认允许长期无人值守？"],
          },
        },
      },
    });

    const card = rendered.card as { header?: { template?: string } };
    const text = JSON.stringify(rendered.card);
    expect(card.header?.template).toBe("green");
    expect(text).toContain("🎯 Current Conclusion");
    expect(text).not.toContain("collapsible_panel");
  });
});
