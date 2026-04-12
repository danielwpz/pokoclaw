import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createWebSearchTool } from "@/src/tools/web/search.js";

const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
}));

vi.mock("@tavily/core", () => ({
  tavily: vi.fn(() => ({
    search: searchMock,
  })),
}));

describe("web_search tool", () => {
  beforeEach(() => {
    searchMock.mockReset();
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
          providerId: "tavily",
          providerApi: "tavily",
          query: "latest pokoclaw news",
          answer: "Short answer",
          requestId: "req_123",
          responseTimeMs: 321,
          creditsUsed: 2,
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
});
