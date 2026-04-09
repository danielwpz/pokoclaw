import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "toml";
import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { LiveConfigManager } from "@/src/config/live-manager.js";
import { buildAppConfigFromInputs, readOptionalTomlFile } from "@/src/config/load.js";
import { patchScenarioModelListInToml } from "@/src/config/model-scenario-patch.js";
import type { AppConfig, ModelCatalogEntry } from "@/src/config/schema.js";

export interface ScenarioModelCatalogSummary {
  index: number;
  modelId: string;
  providerId: string;
  upstreamModelId: string;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export interface ScenarioModelStateSummary {
  scenario: ModelScenario;
  currentModelId: string | null;
  configuredModelIds: string[];
}

export interface ScenarioModelSwitchOverview {
  models: ScenarioModelCatalogSummary[];
  scenarios: ScenarioModelStateSummary[];
}

export interface SwitchScenarioModelInput {
  scenario: ModelScenario;
  modelId: string;
}

export interface SwitchScenarioModelResult {
  scenario: ModelScenario;
  previousModelId: string | null;
  nextModelId: string;
  configuredModelIds: string[];
  reloaded: boolean;
  version: number;
  warnings: string[];
}

export class ScenarioModelSwitchService {
  constructor(
    private readonly config: Pick<
      LiveConfigManager,
      "getSnapshot" | "getFilePaths" | "reloadFromDisk"
    >,
  ) {}

  getOverview(): ScenarioModelSwitchOverview {
    const snapshot = this.config.getSnapshot();
    return {
      models: snapshot.models.catalog.map((model, index) =>
        summarizeCatalogModel(model, index + 1),
      ),
      scenarios: listScenarioStates(snapshot),
    };
  }

  getScenarioOptions(scenario: ModelScenario): {
    scenario: ModelScenario;
    currentModelId: string | null;
    models: ScenarioModelCatalogSummary[];
  } {
    const snapshot = this.config.getSnapshot();
    const configuredModelIds = snapshot.models.scenarios[scenario];
    return {
      scenario,
      currentModelId: configuredModelIds[0] ?? null,
      models: snapshot.models.catalog.map((model, index) =>
        summarizeCatalogModel(model, index + 1),
      ),
    };
  }

  async switchScenarioModel(input: SwitchScenarioModelInput): Promise<SwitchScenarioModelResult> {
    const filePaths = this.config.getFilePaths();
    if (filePaths == null) {
      throw new Error(
        "Scenario model switching is unavailable because config file paths are not configured.",
      );
    }

    const snapshot = this.config.getSnapshot();
    assertScenarioExists(snapshot, input.scenario);
    const catalogModel =
      snapshot.models.catalog.find((candidate) => candidate.id === input.modelId) ?? null;
    if (catalogModel == null) {
      throw new Error(`Unknown model id: ${input.modelId}`);
    }

    const configuredModelIds = moveModelToFront(
      snapshot.models.scenarios[input.scenario],
      input.modelId,
    );
    const originalText = await readConfigTomlText(filePaths.configTomlPath);
    const candidateText = patchScenarioModelListInToml({
      tomlText: originalText,
      scenario: input.scenario,
      modelIds: configuredModelIds,
    });
    await validateCandidateConfig({
      candidateTomlText: candidateText,
      secretsTomlPath: filePaths.secretsTomlPath,
    });
    await writeFileAtomically(filePaths.configTomlPath, candidateText);
    const reload = await this.config.reloadFromDisk(
      `scenario_model_switch:${input.scenario}:${input.modelId}`,
    );

    return {
      scenario: input.scenario,
      previousModelId: snapshot.models.scenarios[input.scenario][0] ?? null,
      nextModelId: input.modelId,
      configuredModelIds,
      reloaded: reload.reloaded,
      version: reload.version,
      warnings: buildScenarioSwitchWarnings(catalogModel),
    };
  }
}

function summarizeCatalogModel(
  model: ModelCatalogEntry,
  index: number,
): ScenarioModelCatalogSummary {
  return {
    index,
    modelId: model.id,
    providerId: model.provider,
    upstreamModelId: model.upstreamId,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    supportsReasoning: model.reasoning?.enabled === true,
  };
}

function listScenarioStates(snapshot: AppConfig): ScenarioModelStateSummary[] {
  return (Object.keys(snapshot.models.scenarios) as ModelScenario[]).map((scenario) => ({
    scenario,
    currentModelId: snapshot.models.scenarios[scenario][0] ?? null,
    configuredModelIds: [...snapshot.models.scenarios[scenario]],
  }));
}

function assertScenarioExists(snapshot: AppConfig, scenario: ModelScenario): void {
  if (!(scenario in snapshot.models.scenarios)) {
    throw new Error(`Unknown model scenario: ${scenario}`);
  }
}

function moveModelToFront(modelIds: string[], targetModelId: string): string[] {
  const remaining = modelIds.filter((modelId) => modelId !== targetModelId);
  return [targetModelId, ...remaining];
}

async function readConfigTomlText(configTomlPath: string): Promise<string> {
  try {
    return await readFile(configTomlPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return "";
    }
    throw error;
  }
}

async function validateCandidateConfig(input: {
  candidateTomlText: string;
  secretsTomlPath: string;
}): Promise<void> {
  const rawConfigInput =
    input.candidateTomlText.trim().length === 0 ? undefined : parse(input.candidateTomlText);
  const rawSecretsInput = await readOptionalTomlFile(input.secretsTomlPath);
  buildAppConfigFromInputs(rawConfigInput, rawSecretsInput);
}

async function writeFileAtomically(targetPath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, targetPath);
}

function buildScenarioSwitchWarnings(model: ModelCatalogEntry): string[] {
  const warnings: string[] = [];
  if (!model.supportsTools) {
    warnings.push("该模型不支持 tools，某些依赖工具调用的场景可能受影响。");
  }
  return warnings;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
