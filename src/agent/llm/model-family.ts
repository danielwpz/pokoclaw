import type { Api, Model } from "@mariozechner/pi-ai";

export function isGptFamilyModel(model: Pick<Model<Api>, "id"> & { name?: string }): boolean {
  return isGptFamilyIdentifier(model.id, model.name);
}

export function isGptFamilyResolvedModel(model: { id: string; upstreamId: string }): boolean {
  return isGptFamilyIdentifier(model.id, model.upstreamId);
}

function isGptFamilyIdentifier(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes("gpt"));
}
