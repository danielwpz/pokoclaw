import { type TavilyExtractOptions, type TavilySearchOptions, tavily } from "@tavily/core";
import type { ProviderConfig } from "@/src/config/schema.js";
import type {
  FetchProvider,
  SearchProvider,
  WebFetchRequest,
  WebFetchResponse,
  WebSearchRequest,
  WebSearchResponse,
} from "@/src/tools/web/providers.js";

class TavilySearchProvider implements SearchProvider {
  readonly providerApi = "tavily" as const;
  readonly providerId: string;
  private readonly apiKey: string;

  constructor(input: { providerId: string; providerConfig: ProviderConfig }) {
    this.providerId = input.providerId;
    this.apiKey = requireProviderApiKey(input.providerId, input.providerConfig);
  }

  async search(req: WebSearchRequest): Promise<WebSearchResponse> {
    const client = tavily({ apiKey: this.apiKey });
    const options: TavilySearchOptions = {
      maxResults: req.maxResults,
      includeAnswer: "basic",
    };
    const response = await client.search(req.query, options);

    return {
      providerId: this.providerId,
      providerApi: this.providerApi,
      query: response.query,
      ...(response.answer == null ? {} : { answer: response.answer }),
      ...(response.requestId == null ? {} : { requestId: response.requestId }),
      ...(response.responseTime == null ? {} : { responseTimeMs: response.responseTime }),
      ...(response.usage?.credits == null ? {} : { creditsUsed: response.usage.credits }),
      results: response.results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
        ...(item.score == null ? {} : { score: item.score }),
        ...(item.publishedDate == null ? {} : { publishedAt: item.publishedDate }),
      })),
    };
  }
}

class TavilyFetchProvider implements FetchProvider {
  readonly providerApi = "tavily" as const;
  readonly providerId: string;
  private readonly apiKey: string;

  constructor(input: { providerId: string; providerConfig: ProviderConfig }) {
    this.providerId = input.providerId;
    this.apiKey = requireProviderApiKey(input.providerId, input.providerConfig);
  }

  async fetch(req: WebFetchRequest): Promise<WebFetchResponse> {
    const client = tavily({ apiKey: this.apiKey });
    const options: TavilyExtractOptions = {
      format: "markdown",
      extractDepth: "basic",
      includeImages: false,
    };
    const response = await client.extract([req.url], options);

    const failed = response.failedResults.find((item) => item.url === req.url);
    if (failed != null) {
      throw new Error(`Failed to fetch URL: ${failed.error}`);
    }

    const result = response.results.find((item) => item.url === req.url);
    if (result == null) {
      throw new Error("Fetch provider returned no result for this URL.");
    }

    return {
      providerId: this.providerId,
      providerApi: this.providerApi,
      url: result.url,
      title: result.title,
      content: result.rawContent,
      ...(response.requestId == null ? {} : { requestId: response.requestId }),
      ...(response.responseTime == null ? {} : { responseTimeMs: response.responseTime }),
      ...(response.usage?.credits == null ? {} : { creditsUsed: response.usage.credits }),
    };
  }
}

export function createTavilySearchProvider(input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): SearchProvider {
  return new TavilySearchProvider(input);
}

export function createTavilyFetchProvider(input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): FetchProvider {
  return new TavilyFetchProvider(input);
}

function requireProviderApiKey(providerId: string, providerConfig: ProviderConfig): string {
  const apiKey = providerConfig.apiKey?.trim();
  if (apiKey == null || apiKey.length === 0) {
    throw new Error(`Provider "${providerId}" is missing apiKey.`);
  }

  return apiKey;
}
