import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { createWebFetchTool } from "@/src/tools/web/fetch.js";

const { extractMock } = vi.hoisted(() => ({
  extractMock: vi.fn(),
}));

vi.mock("@tavily/core", () => ({
  tavily: vi.fn(() => ({
    extract: extractMock,
  })),
}));

describe("web_fetch tool", () => {
  beforeEach(() => {
    extractMock.mockReset();
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

    const tool = createWebFetchTool({
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
        url: "https://example.com/post",
      },
    );

    expect(extractMock).toHaveBeenCalledWith(["https://example.com/post"], {
      extractDepth: "basic",
      format: "markdown",
      includeImages: false,
    });
    expect(result.content[0]).toEqual({
      type: "json",
      json: {
        providerId: "tavily",
        providerApi: "tavily",
        url: "https://example.com/post",
        title: "Example title",
        content: "A".repeat(100_000),
        requestId: "req_fetch",
        responseTimeMs: 222,
        creditsUsed: 1,
        truncated: true,
        originalContentLength: 110_000,
      },
    });
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
});
