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

const DEFAULT_KEENABLE_BASE_URL = "https://api.keenable.ai";
const KEENABLE_APP_TITLE = "pokoclaw";
const KEENABLE_SNIPPET_MAX_LENGTH = 1_000;

class KeenableSearchProvider implements SearchProvider {
  readonly providerApi = "keenable" as const;
  readonly providerId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(input: { providerId: string; providerConfig: ProviderConfig }) {
    this.providerId = input.providerId;
    this.apiKey = requireProviderApiKey(input.providerId, input.providerConfig);
    this.baseUrl = input.providerConfig.baseUrl ?? DEFAULT_KEENABLE_BASE_URL;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResponse> {
    const { body, requestId } = await postKeenableJson({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      endpoint: "search",
      ...(req.signal == null ? {} : { signal: req.signal }),
      body: {
        query: req.query,
        max_results: req.maxResults,
        snippet_max_length: KEENABLE_SNIPPET_MAX_LENGTH,
      },
    });
    const root = requireRecord(body, "Keenable search returned an invalid response.");
    if (!Array.isArray(root.results)) {
      throw invalidResponse("Keenable search response is missing results.");
    }

    const results = root.results.flatMap((value) => {
      const item = asRecord(value);
      const url = readString(item?.url);
      if (item == null || url == null) {
        return [];
      }
      const title = readNonEmptyString(item.title) ?? url;
      const snippet = readNonEmptyString(item.snippet) ?? readString(item.description) ?? "";
      const publishedAt = readNonEmptyString(item.published_at);
      return [{ title, url, snippet, ...(publishedAt == null ? {} : { publishedAt }) }];
    });

    return {
      providerId: this.providerId,
      providerApi: this.providerApi,
      query: readString(root.query) ?? req.query,
      ...(requestId == null ? {} : { requestId }),
      results,
    };
  }
}

class KeenableFetchProvider implements FetchProvider {
  readonly providerApi = "keenable" as const;
  readonly providerId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(input: { providerId: string; providerConfig: ProviderConfig }) {
    this.providerId = input.providerId;
    this.apiKey = requireProviderApiKey(input.providerId, input.providerConfig);
    this.baseUrl = input.providerConfig.baseUrl ?? DEFAULT_KEENABLE_BASE_URL;
  }

  async fetch(req: WebFetchRequest): Promise<WebFetchResponse> {
    const { body, requestId } = await postKeenableJson({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      endpoint: "fetch",
      ...(req.signal == null ? {} : { signal: req.signal }),
      body: { urls: [req.url] },
    });
    const root = requireRecord(body, "Keenable fetch returned an invalid response.");
    if (!Array.isArray(root.results) || root.results.length === 0) {
      throw invalidResponse("Keenable fetch response is missing results.");
    }
    const result = requireRecord(root.results[0], "Keenable fetch result is invalid.");

    // A page the fetcher could not read still comes back inside an HTTP 200, with a
    // per-URL `error`. That is a failure of the target page, not of the provider, so it
    // must not be classified as an authentication or quota failure.
    const pageError = asRecord(result.error);
    if (pageError != null) {
      throw targetPageError(pageError);
    }

    const content = readString(result.content);
    if (content == null) {
      throw invalidResponse("Keenable fetch result is missing content.");
    }

    return {
      providerId: this.providerId,
      providerApi: this.providerApi,
      url: readString(result.url) ?? req.url,
      title: readNonEmptyString(result.title) ?? null,
      content,
      ...(result.truncated === true ? { truncated: true } : {}),
      ...(requestId == null ? {} : { requestId }),
    };
  }
}

export function createKeenableSearchProvider(input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): SearchProvider {
  return new KeenableSearchProvider(input);
}

export function createKeenableFetchProvider(input: {
  providerId: string;
  providerConfig: ProviderConfig;
}): FetchProvider {
  return new KeenableFetchProvider(input);
}

async function postKeenableJson(input: {
  baseUrl: string;
  apiKey: string;
  endpoint: "search" | "fetch";
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ body: unknown; requestId?: string }> {
  const response = await fetch(buildKeenableUrl(input.baseUrl, input.endpoint), {
    method: "POST",
    headers: {
      "X-API-Key": input.apiKey,
      "X-Keenable-Title": KEENABLE_APP_TITLE,
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
    if (!response.ok) {
      // A proxy or gateway can answer with plain text or HTML; classify by status so
      // a 401 still blocks and a 429 keeps its Retry-After.
      throw createHttpProviderError(
        response.status,
        `Keenable request failed with HTTP ${response.status}.`,
        response.headers,
      );
    }
    throw invalidResponse("Keenable returned a non-JSON response.");
  }

  const record = asRecord(body);
  if (!response.ok) {
    const errorMessage =
      readString(record?.message) ??
      readString(record?.error) ??
      `Keenable request failed with HTTP ${response.status}.`;
    throw createHttpProviderError(response.status, errorMessage, response.headers);
  }

  const requestId = response.headers.get("x-request-id") ?? undefined;
  return { body, ...(requestId == null ? {} : { requestId }) };
}

function buildKeenableUrl(baseUrl: string, endpoint: "search" | "fetch"): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new WebProviderError({
      code: "invalid_request",
      message: "Keenable provider baseUrl is invalid.",
      retryable: false,
    });
  }
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  const versionedPath = basePath.endsWith("/v1") ? basePath : `${basePath}/v1`;
  parsed.pathname = `${versionedPath}/${endpoint}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function targetPageError(error: Record<string, unknown>): WebProviderError {
  const status = readNumber(error.status);
  const message =
    readString(error.message) ?? readString(error.error) ?? "Keenable could not fetch this URL.";
  if (status === 404 || status === 410) {
    return new WebProviderError({
      code: "not_found",
      message: `Failed to fetch URL: ${message}`,
      retryable: false,
    });
  }
  if (error.retryable === true) {
    return new WebProviderError({
      code: "upstream_error",
      message: `Failed to fetch URL: ${message}`,
      retryable: true,
    });
  }
  // The target page refused or failed (e.g. 403): the request needs a different URL,
  // the provider itself is healthy.
  return new WebProviderError({
    code: "invalid_request",
    message: `Failed to fetch URL: ${message}`,
    retryable: false,
    ...(status == null ? {} : { statusCode: status }),
  });
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

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invalidResponse(message: string): WebProviderError {
  return new WebProviderError({
    code: "invalid_response",
    message,
    retryable: true,
  });
}
