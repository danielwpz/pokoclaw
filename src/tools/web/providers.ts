import type { ProviderConfig } from "@/src/config/schema.js";
import { createBraveSearchProvider } from "@/src/tools/web/providers/brave.js";
import {
  createFirecrawlFetchProvider,
  createFirecrawlSearchProvider,
} from "@/src/tools/web/providers/firecrawl.js";
import {
  createTavilyFetchProvider,
  createTavilySearchProvider,
} from "@/src/tools/web/providers/tavily.js";

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
}

export interface WebSearchRequest {
  query: string;
  maxResults: number;
  signal?: AbortSignal;
}

export interface WebSearchResponse {
  providerId: string;
  providerApi: string;
  query: string;
  results: WebSearchItem[];
  answer?: string;
  requestId?: string;
  responseTimeMs?: number;
  creditsUsed?: number;
}

export interface WebFetchRequest {
  url: string;
  signal?: AbortSignal;
}

export interface WebFetchResponse {
  providerId: string;
  providerApi: string;
  url: string;
  title: string | null;
  content: string;
  requestId?: string;
  responseTimeMs?: number;
  creditsUsed?: number;
}

export interface SearchProvider {
  readonly providerId: string;
  readonly providerApi: string;
  search(req: WebSearchRequest): Promise<WebSearchResponse>;
}

export interface FetchProvider {
  readonly providerId: string;
  readonly providerApi: string;
  fetch(req: WebFetchRequest): Promise<WebFetchResponse>;
}

export interface WebProviderConfigInput {
  providerId: string;
  providerConfig: ProviderConfig;
}

export function createSearchProvider(input: WebProviderConfigInput): SearchProvider {
  switch (input.providerConfig.api) {
    case "tavily":
      return createTavilySearchProvider(input);
    case "brave":
      return createBraveSearchProvider(input);
    case "firecrawl":
      return createFirecrawlSearchProvider(input);
    default:
      throw new Error(
        `web_search does not support provider api "${input.providerConfig.api}" yet.`,
      );
  }
}

export function createFetchProvider(input: WebProviderConfigInput): FetchProvider {
  switch (input.providerConfig.api) {
    case "tavily":
      return createTavilyFetchProvider(input);
    case "firecrawl":
      return createFirecrawlFetchProvider(input);
    default:
      throw new Error(`web_fetch does not support provider api "${input.providerConfig.api}" yet.`);
  }
}
