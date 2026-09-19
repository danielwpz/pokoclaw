import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createWebSearchTool } from "@/src/tools/web/search.js";

const { fetchMock, searchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  searchMock: vi.fn(),
}));

vi.mock("@tavily/core", () => ({
  tavily: vi.fn(() => ({
    search: searchMock,
  })),
}));

describe("web_search tool", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    searchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  test("maps Tavily search results into the tool response shape", async () => {
    searchMock.mockResolvedValue({
      query: "latest pokoclaw news",
      answer: "Short answer",
      requestId: "req_123",
      responseTime: 321,
      usage: { credits: 2 },
      results: [
        {
          title: "Pokoclaw launch",
          url: "https://example.com/news",
          content: "Snippet text",
          score: 0.91,
          publishedDate: "2026-04-02",
        },
      ],
    });

    const tool = createWebSearchTool({
      providerId: "tavily",
      providerConfig: {
        api: "tavily",
        apiKey: "tvly-test",
      },
    });

    const result = await tool.execute(
      {
        sessionId: "session_1",
        conversationId: "conversation_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: {} as never,
      },
      {
        query: "latest pokoclaw news",
        maxResults: 4,
      },
    );

    expect(searchMock).toHaveBeenCalledWith("latest pokoclaw news", {
      includeAnswer: "basic",
      maxResults: 4,
    });
    expect(result.content).toEqual([
      {
        type: "json",
        json: {
          query: "latest pokoclaw news",
          answer: "Short answer",
          results: [
            {
              title: "Pokoclaw launch",
              url: "https://example.com/news",
              snippet: "Snippet text",
              score: 0.91,
              publishedAt: "2026-04-02",
            },
          ],
        },
      },
    ]);
  });

  test("maps Firecrawl search results without exposing provider diagnostics", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          id: "fc_req_1",
          creditsUsed: 1,
          data: {
            web: [
              {
                title: "Pokoclaw docs",
                description: "Official documentation",
                url: "https://example.com/docs",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const tool = createWebSearchTool({
      providerId: "firecrawl",
      providerConfig: { api: "firecrawl", apiKey: "fc-test" },
    });
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
      "https://api.firecrawl.dev/v2/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "pokoclaw", limit: 3, sources: ["web"] }),
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
          ],
        },
      },
    ]);
  });

  test("falls back from Tavily to Firecrawl inside the tool", async () => {
    searchMock.mockRejectedValue(new Error("Tavily transport failed"));
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              { title: "Fallback result", description: "Found", url: "https://example.com/found" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const tool = createWebSearchTool({
      providerId: "tavily",
      providerConfig: { api: "tavily", apiKey: "tvly-test" },
      fallbackProvider: {
        providerId: "firecrawl",
        providerConfig: { api: "firecrawl", apiKey: "fc-test" },
      },
    });

    const result = await tool.execute(
      {
        sessionId: "session_1",
        conversationId: "conversation_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: {} as never,
      },
      { query: "fallback" },
    );

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      {
        type: "json",
        json: {
          query: "fallback",
          results: [
            {
              title: "Fallback result",
              url: "https://example.com/found",
              snippet: "Found",
            },
          ],
        },
      },
    ]);
  });

  test("reports a provider-neutral non-retryable failure when every service rejects access", async () => {
    searchMock.mockRejectedValue(new Error("Unauthorized: missing or invalid API key."));
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Firecrawl payment required" }), { status: 402 }),
    );
    const tool = createWebSearchTool({
      providerId: "tavily",
      providerConfig: { api: "tavily", apiKey: "tvly-test" },
      fallbackProvider: {
        providerId: "firecrawl",
        providerConfig: { api: "firecrawl", apiKey: "fc-test" },
      },
    });

    await expect(
      tool.execute(
        {
          sessionId: "session_1",
          conversationId: "conversation_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: {} as never,
        },
        { query: "fallback" },
      ),
    ).rejects.toMatchObject({
      retryable: false,
      details: {
        code: "web_search_failed",
        reason: "system_unavailable",
        retryable: false,
        recommendedAction: "report",
      },
    });
  });

  test("marks an exhausted temporary provider chain as retryable", async () => {
    searchMock.mockRejectedValue(new Error("socket timed out"));
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "Upstream unavailable" }), {
        status: 503,
      }),
    );
    const tool = createWebSearchTool({
      providerId: "tavily",
      providerConfig: { api: "tavily", apiKey: "tvly-test" },
      fallbackProvider: {
        providerId: "firecrawl",
        providerConfig: { api: "firecrawl", apiKey: "fc-test" },
      },
    });

    await expect(
      tool.execute(
        {
          sessionId: "session_1",
          conversationId: "conversation_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: {} as never,
        },
        { query: "fallback" },
      ),
    ).rejects.toMatchObject({
      retryable: true,
      details: {
        code: "web_search_failed",
        reason: "temporary_unavailable",
        retryable: true,
        recommendedAction: "retry",
      },
    });
  });

  test("allows an unchanged retry after host-managed rate limiting without exposing timing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );
    const tool = createWebSearchTool({
      providerId: "firecrawl",
      providerConfig: { api: "firecrawl", apiKey: "fc-test" },
    });

    const result = tool.execute(
      {
        sessionId: "session_1",
        conversationId: "conversation_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: {} as never,
      },
      { query: "retry unchanged" },
    );

    await expect(result).rejects.toMatchObject({
      retryable: true,
      message:
        "web_search was temporarily rate limited. Retry the same request; the host will manage the timing.",
      details: {
        code: "web_search_failed",
        reason: "rate_limited",
        retryable: true,
        retryManagedByHost: true,
        recommendedAction: "retry",
      },
    });
    await expect(result).rejects.not.toThrow(/120|firecrawl|retry-after/iu);
  });
});
