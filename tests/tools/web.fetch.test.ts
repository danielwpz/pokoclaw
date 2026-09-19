import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { TOOL_RESULT_TRUNCATION_NOTICE, ToolRegistry } from "@/src/tools/core/registry.js";
import { createWebFetchTool, WEB_FETCH_RESULT_MAX_CHARS } from "@/src/tools/web/fetch.js";

const { extractMock, fetchMock } = vi.hoisted(() => ({
  extractMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@tavily/core", () => ({
  tavily: vi.fn(() => ({
    extract: extractMock,
  })),
}));

describe("web_fetch tool", () => {
  beforeEach(() => {
    extractMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  test("maps Tavily extract results and truncates oversized content", async () => {
    extractMock.mockResolvedValue({
      requestId: "req_fetch",
      responseTime: 222,
      usage: { credits: 1 },
      failedResults: [],
      results: [
        {
          url: "https://example.com/post",
          title: "Example title",
          rawContent: "A".repeat(110_000),
        },
      ],
    });

    const registry = new ToolRegistry([
      createWebFetchTool({
        providerId: "tavily",
        providerConfig: {
          api: "tavily",
          apiKey: "tvly-test",
        },
      }),
    ]);

    const result = await registry.execute(
      "web_fetch",
      {
        sessionId: "session_1",
        conversationId: "conversation_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: {} as never,
      },
      {
        url: "https://example.com/post",
      },
    );

    expect(extractMock).toHaveBeenCalledWith(["https://example.com/post"], {
      extractDepth: "basic",
      format: "markdown",
      includeImages: false,
    });
    expect(result.content).toHaveLength(1);
    const firstBlock = result.content[0];
    expect(firstBlock).toBeDefined();
    expect(firstBlock?.type).toBe("text");
    expect((firstBlock as { type: "text"; text: string }).text).not.toContain("providerId");
    expect((firstBlock as { type: "text"; text: string }).text).toContain(
      TOOL_RESULT_TRUNCATION_NOTICE,
    );
    expect((firstBlock as { type: "text"; text: string }).text.length).toBe(
      WEB_FETCH_RESULT_MAX_CHARS,
    );
  });

  test("blocks fetches to denied hosts before provider execution", async () => {
    const tool = createWebFetchTool({
      providerId: "tavily",
      providerConfig: {
        api: "tavily",
        apiKey: "tvly-test",
      },
    });

    await expect(
      tool.execute(
        {
          sessionId: "session_1",
          conversationId: "conversation_1",
          securityConfig: {
            ...DEFAULT_CONFIG.security,
            network: {
              overrideHardDenyHosts: false,
              hardDenyHosts: ["blocked.example.com"],
            },
          },
          storage: {} as never,
        },
        {
          url: "https://blocked.example.com/secret",
        },
      ),
    ).rejects.toThrow("Network access to blocked.example.com is blocked by policy.");

    expect(extractMock).not.toHaveBeenCalled();
  });

  test("uses Firecrawl scrape as a provider-neutral fallback", async () => {
    extractMock.mockRejectedValue(new Error("Tavily extract unavailable"));
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: "# Firecrawl content",
            metadata: {
              title: "Fetched title",
              sourceURL: "https://example.com/post",
            },
          },
        }),
        { status: 200 },
      ),
    );
    const tool = createWebFetchTool({
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
      { url: "https://example.com/post" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v2/scrape",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/post",
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      }),
    );
    expect(result.content).toEqual([
      {
        type: "json",
        json: {
          url: "https://example.com/post",
          title: "Fetched title",
          content: "# Firecrawl content",
          truncated: false,
          originalContentLength: 19,
        },
      },
    ]);
  });
});
