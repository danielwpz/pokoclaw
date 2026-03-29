import type { Api, Model } from "@mariozechner/pi-ai";
import { isGptFamilyModel, isGptFamilyResolvedModel } from "@/src/agent/llm/model-family.js";
import type { ResolvedModel } from "@/src/agent/llm/models.js";

type OpenAICompatibleApi = "openai-completions" | "openai-responses";
export interface OpenAICompatPolicy {
  supportsDeveloperRole: boolean;
}

export function resolveOpenAICompatForPiModel(
  model: Pick<Model<Api>, "api" | "id"> & { name?: string },
): OpenAICompatPolicy | null {
  if (!isOpenAICompatibleApi(model.api)) {
    return null;
  }

  return {
    supportsDeveloperRole: isGptFamilyModel(model),
  };
}

export function resolveOpenAICompatForResolvedModel(
  model: Pick<ResolvedModel, "provider" | "id" | "upstreamId">,
): OpenAICompatPolicy | null {
  const api = resolveOpenAICompatibleApi(model);
  if (api == null) {
    return null;
  }

  return {
    supportsDeveloperRole: isGptFamilyResolvedModel(model),
  };
}

function resolveOpenAICompatibleApi(
  model: Pick<ResolvedModel, "provider" | "id" | "upstreamId">,
): OpenAICompatibleApi | null {
  if (model.provider.api === "openai-completions") {
    return "openai-completions";
  }

  if (model.provider.api === "openai-responses") {
    return isGptFamilyResolvedModel(model) ? "openai-responses" : "openai-completions";
  }

  return null;
}

function isOpenAICompatibleApi(api: Api): api is OpenAICompatibleApi {
  return api === "openai-completions" || api === "openai-responses";
}
