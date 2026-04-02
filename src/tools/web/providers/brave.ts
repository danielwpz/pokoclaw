import type { ProviderConfig } from "@/src/config/schema.js";
import type { SearchProvider } from "@/src/tools/web/providers.js";

export function createBraveSearchProvider(_input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): SearchProvider {
  throw new Error("Brave web_search provider is not implemented yet.");
}
