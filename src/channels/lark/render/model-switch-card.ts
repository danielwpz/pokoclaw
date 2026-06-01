import type {
  ScenarioModelCatalogSummary,
  ScenarioModelStateSummary,
  ScenarioModelSwitchOverview,
} from "@/src/config/scenario-model-switch.js";

export interface LarkModelSwitchCardState {
  overview: ScenarioModelSwitchOverview;
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
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: false,
      summary: {
        content: buildSummary(state),
      },
    },
    header: {
      title: {
        tag: "plain_text",
        content: "模型切换",
      },
      subtitle: {
        tag: "plain_text",
        content: "为每个场景选择首选模型，然后点击确定",
      },
      template: state.warnings != null && state.warnings.length > 0 ? "orange" : "turquoise",
    },
    body: {
      elements: buildModelSwitchCardElements(state),
    },
  };

  return {
    card,
    structureSignature: JSON.stringify(card),
  };
}

function buildModelSwitchCardElements(
  state: LarkModelSwitchCardState,
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
  elements.push(buildModelSwitchForm(state.overview));

  return elements;
}

function buildOverviewMarkdown(overview: ScenarioModelSwitchOverview): string {
  const modelLines = overview.models.map(
    (model) =>
      `${model.index}. **${model.modelId}** · provider: \`${model.providerId}\` · upstream: \`${model.upstreamModelId}\` · tools: ${model.supportsTools ? "yes" : "no"} · reasoning: ${model.supportsReasoning ? "yes" : "no"}${model.serviceTier == null ? "" : ` · tier: ${model.serviceTier}`}`,
  );
  const scenarioLines = overview.scenarios.map(
    (scenario) =>
      `- **${scenario.scenario}** → ${scenario.currentModelId == null ? "(未配置)" : `\`${scenario.currentModelId}\``}`,
  );
  return ["### 模型目录", ...modelLines, "", "### 当前场景", ...scenarioLines].join("\n");
}

function buildModelSwitchForm(overview: ScenarioModelSwitchOverview): Record<string, unknown> {
  return {
    tag: "form",
    name: "model_switch_form",
    elements: [
      {
        tag: "markdown",
        content: "### 选择模型",
      },
      ...overview.scenarios.flatMap((scenario) =>
        buildScenarioModelSelectElements(scenario, overview.models),
      ),
      {
        tag: "button",
        name: "model_switch_submit",
        type: "primary",
        form_action_type: "submit",
        text: {
          tag: "plain_text",
          content: "确定",
        },
        value: {
          action: "model_switch_submit",
        },
      },
    ],
  };
}

function buildScenarioModelSelectElements(
  scenario: ScenarioModelStateSummary,
  models: ScenarioModelCatalogSummary[],
): Array<Record<string, unknown>> {
  return [
    {
      tag: "markdown",
      content: `**场景：${scenario.scenario}**`,
    },
    {
      tag: "select_static",
      name: scenario.scenario,
      placeholder: {
        tag: "plain_text",
        content: `${scenario.scenario} 模型`,
      },
      ...(scenario.currentModelId == null ? {} : { initial_option: scenario.currentModelId }),
      options: models.map((model) => ({
        text: {
          tag: "plain_text",
          content: `${model.index}. ${model.modelId}`,
        },
        value: model.modelId,
      })),
      required: true,
    },
  ];
}

function buildSummary(state: LarkModelSwitchCardState): string {
  if (state.message != null && state.message.length > 0) {
    return state.message;
  }
  return "查看场景当前模型并切换首选模型";
}
