import type { ModelScenario } from "@/src/agent/llm/models.js";
import type {
  ScenarioModelCatalogSummary,
  ScenarioModelStateSummary,
  ScenarioModelSwitchOverview,
} from "@/src/config/scenario-model-switch.js";

export interface LarkModelSwitchCardState {
  overview: ScenarioModelSwitchOverview;
  selectedScenario: ModelScenario | null;
  message?: string | null;
  warnings?: string[];
}

export interface LarkRenderedModelSwitchCard {
  card: Record<string, unknown>;
  structureSignature: string;
}

export function buildLarkRenderedModelSwitchCard(
  state: LarkModelSwitchCardState,
): LarkRenderedModelSwitchCard {
  const selectedScenario =
    state.selectedScenario == null
      ? null
      : (state.overview.scenarios.find(
          (scenario) => scenario.scenario === state.selectedScenario,
        ) ?? null);
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: buildSummary(state, selectedScenario),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: "模型切换",
      },
      subtitle: {
        tag: "plain_text",
        content:
          selectedScenario == null
            ? "选择一个场景，然后切换它的首选模型"
            : `当前场景：${selectedScenario.scenario}`,
      },
      template: state.warnings != null && state.warnings.length > 0 ? "orange" : "turquoise",
    },
    body: {
      elements: buildModelSwitchCardElements(state, selectedScenario),
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

function buildModelSwitchCardElements(
  state: LarkModelSwitchCardState,
  selectedScenario: ScenarioModelStateSummary | null,
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  if (state.message != null && state.message.length > 0) {
    elements.push({
      tag: "markdown",
      content: `> ${state.message}`,
    });
  }
  if (state.warnings != null && state.warnings.length > 0) {
    elements.push({
      tag: "markdown",
      content: state.warnings.map((warning) => `- ⚠️ ${warning}`).join("\n"),
    });
  }

  elements.push({
    tag: "markdown",
    content: buildOverviewMarkdown(state.overview),
  });
  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: "### 选择场景",
  });
  for (const scenario of state.overview.scenarios) {
    elements.push(buildScenarioRow(scenario, state.selectedScenario));
  }

  if (selectedScenario != null) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `### 为 **${selectedScenario.scenario}** 选择模型`,
    });
    for (const model of state.overview.models) {
      elements.push(buildModelRow(selectedScenario, model));
    }
  }

  return elements;
}

function buildOverviewMarkdown(overview: ScenarioModelSwitchOverview): string {
  const modelLines = overview.models.map(
    (model) =>
      `${model.index}. **${model.modelId}** · provider: \`${model.providerId}\` · upstream: \`${model.upstreamModelId}\` · tools: ${model.supportsTools ? "yes" : "no"} · reasoning: ${model.supportsReasoning ? "yes" : "no"}`,
  );
  const scenarioLines = overview.scenarios.map(
    (scenario) =>
      `- **${scenario.scenario}** → ${scenario.currentModelId == null ? "(未配置)" : `\`${scenario.currentModelId}\``}`,
  );
  return ["### 模型目录", ...modelLines, "", "### 当前场景", ...scenarioLines].join("\n");
}

function buildScenarioRow(
  scenario: ScenarioModelStateSummary,
  selectedScenario: ModelScenario | null,
): Record<string, unknown> {
  const isSelected = scenario.scenario === selectedScenario;
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 4,
        elements: [
          {
            tag: "markdown",
            content: `**${scenario.scenario}**\n${scenario.currentModelId == null ? "当前未配置" : `当前：\`${scenario.currentModelId}\``}`,
          },
        ],
      },
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "button",
            type: isSelected ? "primary" : "default",
            text: {
              tag: "plain_text",
              content: isSelected ? "已选中" : "选择",
            },
            value: {
              action: "model_switch_select_scenario",
              scenario: scenario.scenario,
            },
          },
        ],
      },
    ],
  };
}

function buildModelRow(
  scenario: ScenarioModelStateSummary,
  model: ScenarioModelCatalogSummary,
): Record<string, unknown> {
  const isCurrent = scenario.currentModelId === model.modelId;
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 5,
        elements: [
          {
            tag: "markdown",
            content: [
              `**${model.index}. ${model.modelId}**${isCurrent ? " · 当前使用" : ""}`,
              `provider: \`${model.providerId}\` · upstream: \`${model.upstreamModelId}\``,
              `tools: ${model.supportsTools ? "yes" : "no"} · reasoning: ${model.supportsReasoning ? "yes" : "no"}`,
            ].join("\n"),
          },
        ],
      },
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "button",
            type: isCurrent ? "default" : "primary",
            text: {
              tag: "plain_text",
              content: isCurrent ? "当前模型" : "切换到这里",
            },
            value: {
              action: "model_switch_apply",
              scenario: scenario.scenario,
              modelId: model.modelId,
            },
          },
        ],
      },
    ],
  };
}

function buildSummary(
  state: LarkModelSwitchCardState,
  selectedScenario: ScenarioModelStateSummary | null,
): string {
  if (state.message != null && state.message.length > 0) {
    return state.message;
  }
  if (selectedScenario != null) {
    return `为 ${selectedScenario.scenario} 选择模型`;
  }
  return "查看场景当前模型并切换首选模型";
}
