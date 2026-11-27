import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { WebProviderError } from "@/src/tools/web/provider-errors.js";
import {
  createKeenableFetchProvider,
  createKeenableSearchProvider,
} from "@/src/tools/web/providers/keenable.js";
import { createWebSearchTool } from "@/src/tools/web/search.js";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

const keenableConfig = { api: "keenable", apiKey: "kn-test" };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe("Keenable web provider", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  test("maps Keenable search results through the web_search tool", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          query: "pokoclaw",
          mode: "pro",
          results: [
            {
              title: "Pokoclaw docs",
              url: "https://example.com/docs",
              description: "",
              snippet: "Official documentation",
            },
            { title: "", url: "https://example.com/untitled", snippet: "" },
            { title: "No URL", snippet: "dropped" },
          ],
        },
        { headers: { "x-request-id": "kn_req_1" } },
      ),
    );

    const tool = createWebSearchTool({ providerId: "keenable", providerConfig: keenableConfig });
    const result = await tool.execute(
      {
        sessionId: "session_1",
        conversationId: "conversation_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: {} as never,
      },
      { query: "pokoclaw", maxResults: 3 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.keenable.ai/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "kn-test",
          "X-Keenable-Title": "pokoclaw",
        }),
        body: JSON.stringify({ query: "pokoclaw", max_results: 3, snippet_max_length: 1000 }),
      }),
    );
    expect(result.content).toEqual([
      {
        type: "json",
        json: {
          query: "pokoclaw",
          results: [
            {
              title: "Pokoclaw docs",
              url: "https://example.com/docs",
              snippet: "Official documentation",
            },
            {
              title: "https://example.com/untitled",
              url: "https://example.com/untitled",
              snippet: "",
            },
          ],
        },
      },
    ]);
  });

  test("honors a custom baseUrl", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ query: "q", results: [] }));
    const provider = createKeenableSearchProvider({
      providerId: "keenable",
      providerConfig: { ...keenableConfig, baseUrl: "https://proxy.example.com/keenable/" },
    });

    await provider.search({ query: "q", maxResults: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example.com/keenable/v1/search",
      expect.anything(),
    );
  });

  test("requires an apiKey", () => {
    expect(() =>
      createKeenableSearchProvider({ providerId: "keenable", providerConfig: { api: "keenable" } }),
    ).toThrow('Provider "keenable" is missing apiKey.');
  });

  test("classifies a rejected key as an authentication failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: "Authentication failed", message: "Malformed API key", code: "invalid_api_key" },
        { status: 401 },
      ),
    );
    const provider = createKeenableSearchProvider({
      providerId: "keenable",
      providerConfig: keenableConfig,
    });

    await expect(provider.search({ query: "q", maxResults: 1 })).rejects.toMatchObject({
      code: "authentication",
      retryable: false,
      statusCode: 401,
      message: "Malformed API key",
    });
  });

  test("passes Retry-After through on a 429", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: "Too many requests", message: "Rate limit exceeded" },
        { status: 429, headers: { "retry-after": "3" } },
      ),
    );
    const provider = createKeenableSearchProvider({
      providerId: "keenable",
      providerConfig: keenableConfig,
    });

    await expect(provider.search({ query: "q", maxResults: 1 })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 3000,
    });
  });

  test("fetches one page through POST /v1/fetch", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            url: "https://example.com/post",
            title: "Fetched title",
            content: "# Keenable content",
            truncated: false,
          },
        ],
      }),
    );
    const provider = createKeenableFetchProvider({
      providerId: "keenable",
      providerConfig: keenableConfig,
    });

    const result = await provider.fetch({ url: "https://example.com/post" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.keenable.ai/v1/fetch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ urls: ["https://example.com/post"] }),
      }),
    );
    expect(result).toMatchObject({
      providerApi: "keenable",
      url: "https://example.com/post",
      title: "Fetched title",
      content: "# Keenable content",
    });
  });

  test("treats a per-URL fetch error inside a 200 as a page failure, not a provider failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            url: "https://example.com/private",
            error: {
              status: 403,
              message: "The target page refused the fetcher.",
              retryable: false,
            },
          },
        ],
      }),
    );
    const provider = createKeenableFetchProvider({
      providerId: "keenable",
      providerConfig: keenableConfig,
    });

    const failure = await provider.fetch({ url: "https://example.com/private" }).catch((e) => e);

    expect(failure).toBeInstanceOf(WebProviderError);
    expect(failure).toMatchObject({ code: "upstream_error", retryable: false });
    expect(failure.code).not.toBe("authentication");
  });

  test("maps a missing target page to not_found", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { url: "https://example.com/gone", error: { status: 404, message: "Not found" } },
        ],
      }),
    );
    const provider = createKeenableFetchProvider({
      providerId: "keenable",
      providerConfig: keenableConfig,
    });

    await expect(provider.fetch({ url: "https://example.com/gone" })).rejects.toMatchObject({
      code: "not_found",
      retryable: false,
    });
  });
});
