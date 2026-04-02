import type { ProviderConfig } from "@/src/config/schema.js";
import type { FetchProvider } from "@/src/tools/web/providers.js";

export function createFirecrawlFetchProvider(_input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): FetchProvider {
  throw new Error("Firecrawl web_fetch provider is not implemented yet.");
}
