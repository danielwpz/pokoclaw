import type { ProviderConfig } from "@/src/config/schema.js";
import { createHttpProviderError, WebProviderError } from "@/src/tools/web/provider-errors.js";
import type {
  FetchProvider,
  SearchProvider,
  WebFetchRequest,
  WebFetchResponse,
  WebSearchRequest,
  WebSearchResponse,
} from "@/src/tools/web/providers.js";

const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";

class FirecrawlSearchProvider implements SearchProvider {
  readonly providerApi = "firecrawl" as const;
  readonly providerId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(input: { providerId: string; providerConfig: ProviderConfig }) {
    this.providerId = input.providerId;
    this.apiKey = requireProviderApiKey(input.providerId, input.providerConfig);
    this.baseUrl = input.providerConfig.baseUrl ?? DEFAULT_FIRECRAWL_BASE_URL;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResponse> {
    const body = await postFirecrawlJson({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      endpoint: "search",
      ...(req.signal == null ? {} : { signal: req.signal }),
      body: {
        query: req.query,
        limit: req.maxResults,
        sources: ["web"],
      },
    });
    const root = requireRecord(body, "Firecrawl search returned an invalid response.");
    const data = requireRecord(root.data, "Firecrawl search response is missing data.");
    if (!Array.isArray(data.web)) {
      throw invalidResponse("Firecrawl search response is missing web results.");
    }

    const results = data.web.flatMap((value) => {
      const item = asRecord(value);
      const url = readString(item?.url);
      if (item == null || url == null) {
        return [];
      }
      const metadata = asRecord(item.metadata);
      const title =
        readString(item.title) ??
        readString(metadata?.title) ??
        readString(metadata?.description) ??
        url;
      const snippet =
        readString(item.description) ??
        readString(metadata?.description) ??
        truncateSnippet(readString(item.markdown) ?? "");
      return [{ title, url, snippet }];
    });

    const requestId = readString(root.id);
    const creditsUsed = readNumber(root.creditsUsed);
    return {
      providerId: this.providerId,
      providerApi: this.providerApi,
      query: req.query,
      ...(requestId == null ? {} : { requestId }),
      ...(creditsUsed == null ? {} : { creditsUsed }),
      results,
    };
  }
}

class FirecrawlFetchProvider implements FetchProvider {
  readonly providerApi = "firecrawl" as const;
  readonly providerId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(input: { providerId: string; providerConfig: ProviderConfig }) {
    this.providerId = input.providerId;
    this.apiKey = requireProviderApiKey(input.providerId, input.providerConfig);
    this.baseUrl = input.providerConfig.baseUrl ?? DEFAULT_FIRECRAWL_BASE_URL;
  }

  async fetch(req: WebFetchRequest): Promise<WebFetchResponse> {
    const body = await postFirecrawlJson({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      endpoint: "scrape",
      ...(req.signal == null ? {} : { signal: req.signal }),
      body: {
        url: req.url,
        formats: ["markdown"],
        onlyMainContent: true,
      },
    });
    const root = requireRecord(body, "Firecrawl scrape returned an invalid response.");
    const data = requireRecord(root.data, "Firecrawl scrape response is missing data.");
    const content = readString(data.markdown);
    if (content == null) {
      throw invalidResponse("Firecrawl scrape response is missing markdown content.");
    }
    const metadata = asRecord(data.metadata);

    const requestId = readString(root.id);
    return {
      providerId: this.providerId,
      providerApi: this.providerApi,
      url: readString(metadata?.sourceURL) ?? readString(metadata?.url) ?? req.url,
      title: readString(metadata?.title) ?? null,
      content,
      ...(requestId == null ? {} : { requestId }),
    };
  }
}

export function createFirecrawlSearchProvider(input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): SearchProvider {
  return new FirecrawlSearchProvider(input);
}

export function createFirecrawlFetchProvider(input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): FetchProvider {
  return new FirecrawlFetchProvider(input);
}

async function postFirecrawlJson(input: {
  baseUrl: string;
  apiKey: string;
  endpoint: "search" | "scrape";
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(buildFirecrawlUrl(input.baseUrl, input.endpoint), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.body),
    ...(input.signal == null ? {} : { signal: input.signal }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidResponse(
      `Firecrawl returned a non-JSON response${response.ok ? "." : ` with HTTP ${response.status}.`}`,
    );
  }

  const record = asRecord(body);
  const errorMessage =
    readString(record?.error) ?? `Firecrawl request failed with HTTP ${response.status}.`;
  if (!response.ok) {
    throw createHttpProviderError(response.status, errorMessage, response.headers);
  }
  if (record?.success !== true) {
    throw new WebProviderError({
      code: "upstream_error",
      message: errorMessage,
      retryable: true,
    });
  }
  return body;
}

function buildFirecrawlUrl(baseUrl: string, endpoint: "search" | "scrape"): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new WebProviderError({
      code: "invalid_request",
      message: "Firecrawl provider baseUrl is invalid.",
      retryable: false,
    });
  }
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  const versionedPath = basePath.endsWith("/v2") ? basePath : `${basePath}/v2`;
  parsed.pathname = `${versionedPath}/${endpoint}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function requireProviderApiKey(providerId: string, providerConfig: ProviderConfig): string {
  const apiKey = providerConfig.apiKey?.trim();
  if (apiKey == null || apiKey.length === 0) {
    throw new Error(`Provider "${providerId}" is missing apiKey.`);
  }
  return apiKey;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record == null) {
    throw invalidResponse(message);
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateSnippet(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 997)}...`;
}

function invalidResponse(message: string): WebProviderError {
  return new WebProviderError({
    code: "invalid_response",
    message,
    retryable: true,
  });
}
