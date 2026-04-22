import type {
  LarkThinkTankConsultationState,
  LarkThinkTankEpisodeState,
} from "@/src/channels/lark/think-tank-state.js";
import type { ThinkTankEpisodeStepSnapshot } from "@/src/think-tank/types.js";

const THINK_TANK_PARTICIPANT_EMOJI = ["🤖", "✨", "🧠", "🔧", "📐", "🛰️"];

export interface LarkRenderedThinkTankCard {
  card: Record<string, unknown>;
  structureSignature: string;
}

export function buildLarkRenderedThinkTankMainCard(
  state: LarkThinkTankConsultationState,
): LarkRenderedThinkTankCard {
  const completed = state.firstCompleted;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: `**讨论主题**：${state.topic}\n主 Agent 已召集多位顾问，从不同视角展开讨论。详细过程持续写入 thread。`,
    },
    {
      tag: "markdown",
      content: [
        "**参与成员**",
        ...state.participants.map((participant, index) => {
          const emoji = THINK_TANK_PARTICIPANT_EMOJI[index] ?? "•";
          const title = participant.title == null ? "未命名顾问" : participant.title;
          return `- ${emoji} 专家 ${String.fromCharCode(65 + index)} · ${title} · ${participant.model}`;
        }),
      ].join("\n"),
    },
    {
      tag: "markdown",
      content: completed
        ? "**状态**：已完成\n主 Agent 已完成至少一轮完整主持并给出当前结论。"
        : "**状态**：正在讨论中\n首轮讨论仍在进行，完整过程会持续写入 thread。",
    },
  ];

  if (completed && state.latestSummary != null) {
    elements.push({ tag: "hr" });
    elements.push(
      buildCompactSummaryBlock("🤝 Agreements", state.latestSummary.agreements.join("\n")),
      buildCompactSummaryBlock("⚡ Key Differences", state.latestSummary.keyDifferences.join("\n")),
      buildCompactSummaryBlock("🎯 Current Conclusion", state.latestSummary.currentConclusion),
    );
  }

  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
      summary: {
        content: completed ? `智囊团已完成：${state.topic}` : `智囊团正在讨论：${state.topic}`,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: completed ? "智囊团 · 已完成" : "智囊团 · 正在讨论中",
      },
      subtitle: {
        tag: "plain_text",
        content: "智囊团圆桌讨论",
      },
      template: completed ? "green" : "blue",
      icon: {
        tag: "standard_icon",
        token: completed ? "yes_filled" : "robot_outlined",
      },
    },
    body: {
      elements,
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

export function buildLarkRenderedThinkTankEpisodeCard(input: {
  consultation: LarkThinkTankConsultationState;
  episode: LarkThinkTankEpisodeState;
}): LarkRenderedThinkTankCard {
  const settled = input.episode.status !== "running";
  const failed = input.episode.status === "failed" || input.episode.status === "cancelled";
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
      summary: {
        content: settled
          ? `第 ${String(input.episode.episodeSequence)} 轮讨论已结束`
          : `第 ${String(input.episode.episodeSequence)} 轮讨论正在进行`,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: settled
          ? `第 ${String(input.episode.episodeSequence)} 轮讨论已完成`
          : `第 ${String(input.episode.episodeSequence)} 轮讨论中`,
      },
      template: failed ? "red" : settled ? "green" : "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**问题**：${input.episode.prompt || input.consultation.topic}`,
        },
        {
          tag: "markdown",
          content: settled
            ? "本轮讨论的各阶段卡片已写入当前 thread。"
            : "主持人已启动本轮讨论，阶段性结论会持续写入当前 thread。",
        },
      ],
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

export function buildLarkRenderedThinkTankStepCard(input: {
  consultation: LarkThinkTankConsultationState;
  step: ThinkTankEpisodeStepSnapshot;
}): LarkRenderedThinkTankCard {
  const card =
    input.step.kind === "participant_round"
      ? buildParticipantRoundCard(input.consultation, input.step)
      : input.step.kind === "moderator_summary"
        ? buildModeratorSummaryCard(input.step)
        : input.step.kind === "final_summary"
          ? buildFinalSummaryCard(input.step)
          : buildErrorCard(input.step);

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

function buildParticipantRoundCard(
  consultation: LarkThinkTankConsultationState,
  step: ThinkTankEpisodeStepSnapshot,
): Record<string, unknown> {
  const roundIndex = step.participantRound?.roundIndex ?? 1;
  const title =
    step.title.trim().length > 0
      ? step.title
      : roundIndex === 1
        ? "Round 1 · 独立观点"
        : `Round ${String(roundIndex)} · 交换意见`;
  const entries = step.participantRound?.entries ?? [];
  const entriesByParticipantId = new Map(entries.map((entry) => [entry.participantId, entry]));
  const elements: Array<Record<string, unknown>> =
    step.status === "pending" && entries.length === 0
      ? [
          {
            tag: "markdown",
            content: "主持人已发出本轮问题，顾问正在思考中。",
          },
        ]
      : consultation.participants.flatMap((participant, index) => {
          const entry = entriesByParticipantId.get(participant.id);
          if (entry == null) {
            return buildPendingExpertSection({
              emoji: THINK_TANK_PARTICIPANT_EMOJI[index] ?? "•",
              name: resolveParticipantDisplayName(consultation, participant.id),
              title: participant.title ?? "未命名顾问",
              model: participant.model,
            });
          }
          return buildExpertSection({
            emoji: THINK_TANK_PARTICIPANT_EMOJI[index] ?? "•",
            name: resolveParticipantDisplayName(consultation, entry.participantId),
            title: entry.title ?? participant.title ?? "未命名顾问",
            model: entry.model,
            content: entry.content,
            preview: entry.preview,
          });
        });

  return buildThreadCard({
    title,
    summary:
      step.status === "pending"
        ? entries.length > 0
          ? "顾问观点正在陆续返回。"
          : "顾问正在进行本轮讨论。"
        : `顾问已完成第 ${String(roundIndex)} 轮输出。`,
    template: roundIndex <= 1 ? "blue" : "turquoise",
    sections: elements,
  });
}

function buildModeratorSummaryCard(step: ThinkTankEpisodeStepSnapshot): Record<string, unknown> {
  const summary = step.moderatorSummary?.summary;
  return buildThreadCard({
    title: step.title.trim().length > 0 ? step.title : "Moderator Synthesis · 第一次汇总",
    summary:
      step.status === "pending"
        ? "主 Agent 正在进行阶段性汇总。"
        : "主 Agent 已总结共同点、分歧点与当前开放问题。",
    template: "carmine",
    sections:
      summary == null
        ? [{ tag: "markdown", content: "主持人正在整理各方观点。" }]
        : [
            ...buildNamedPreviewPanel("🤝 Agreements", summary.agreements.join("\n")),
            ...buildNamedPreviewPanel("⚡ Key Differences", summary.keyDifferences.join("\n")),
            ...buildNamedPreviewPanel("🕳 Open Questions", summary.openQuestions.join("\n")),
          ],
  });
}

function buildFinalSummaryCard(step: ThinkTankEpisodeStepSnapshot): Record<string, unknown> {
  const summary = step.moderatorSummary?.summary;
  return buildThreadCard({
    title: step.title.trim().length > 0 ? step.title : "Final Synthesis · 最终裁决",
    summary:
      step.status === "pending" ? "主 Agent 正在形成当前结论。" : "主 Agent 已完成当前结论。",
    template: "green",
    sections:
      summary == null
        ? [{ tag: "markdown", content: "主持人正在形成结论。" }]
        : [
            buildExpandedSection("🤝 Agreements", summary.agreements.join("\n")),
            buildExpandedSection("⚡ Key Differences", summary.keyDifferences.join("\n")),
            buildExpandedSection("🎯 Current Conclusion", summary.currentConclusion),
          ],
  });
}

function buildErrorCard(step: ThinkTankEpisodeStepSnapshot): Record<string, unknown> {
  return buildThreadCard({
    title: step.title.trim().length > 0 ? step.title : "Think Tank Error",
    summary: "本轮讨论未能完成。",
    template: "red",
    sections: [
      {
        tag: "markdown",
        content: step.error?.message ?? "智囊团本轮讨论失败。",
      },
    ],
  });
}

function buildThreadCard(input: {
  title: string;
  summary: string;
  template: "blue" | "turquoise" | "green" | "carmine" | "red";
  sections: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
      summary: {
        content: input.summary,
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: input.title,
      },
      template: input.template,
    },
    body: {
      elements: input.sections,
    },
  };
}

function buildExpertSection(input: {
  emoji: string;
  name: string;
  title: string;
  model: string;
  content: string;
  preview: string;
}): Array<Record<string, unknown>> {
  return [
    {
      tag: "markdown",
      content: `### ${input.emoji} ${input.name}\n${input.title} · ${input.model}`,
    },
    buildCollapsiblePreviewPanel({
      content: input.content,
      preview: input.preview,
    }),
  ];
}

function buildPendingExpertSection(input: {
  emoji: string;
  name: string;
  title: string;
  model: string;
}): Array<Record<string, unknown>> {
  return [
    {
      tag: "markdown",
      content: `### ${input.emoji} ${input.name}\n${input.title} · ${input.model}`,
    },
    {
      tag: "markdown",
      content: "仍在思考中，结果会继续更新到这张卡片。",
    },
  ];
}

function buildNamedPreviewPanel(title: string, content: string): Array<Record<string, unknown>> {
  return [
    {
      tag: "markdown",
      content: `### ${title}`,
    },
    buildCollapsiblePreviewPanel({
      content,
    }),
  ];
}

function buildCollapsiblePreviewPanel(input: {
  content: string;
  preview?: string;
}): Record<string, unknown> {
  const preview = buildPreview(input.preview ?? input.content, 25);
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: `**${preview}**`,
      },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "4px",
    padding: "8px 10px 8px 10px",
    elements: [
      {
        tag: "markdown",
        content: input.content,
      },
    ],
  };
}

function buildExpandedSection(title: string, content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content: `### ${title}\n${content}`,
  };
}

function buildCompactSummaryBlock(title: string, content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content: `**${title}**\n${compactContent(content)}`,
  };
}

function buildPreview(content: string, maxChars: number): string {
  const compact = compactContent(content);
  const chars = Array.from(compact);
  if (chars.length <= maxChars) {
    return compact;
  }
  return `${chars.slice(0, maxChars).join("")}...`;
}

function compactContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function resolveParticipantDisplayName(
  consultation: LarkThinkTankConsultationState,
  participantId: string,
): string {
  const index = consultation.participants.findIndex(
    (participant) => participant.id === participantId,
  );
  if (index < 0) {
    return participantId;
  }
  return `专家 ${String.fromCharCode(65 + index)}`;
}
