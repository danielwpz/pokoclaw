import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { executeWebProviderChain } from "@/src/tools/web/provider-chain.js";

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/src/shared/logger.js", () => ({
  createSubsystemLogger: vi.fn(() => logger),
}));

describe("web provider chain", () => {
  beforeEach(() => {
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  test("records sanitized primary failure and fallback success diagnostics", async () => {
    const primary = { providerId: "primary", providerApi: "tavily" };
    const fallback = { providerId: "fallback", providerApi: "firecrawl" };

    const response = await executeWebProviderChain({
      toolName: "web_search",
      context: {
        toolCallId: "tool_1",
        sessionId: "session_1",
        conversationId: "conversation_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: {} as never,
      },
      primary,
      fallback,
      execute: async (provider) => {
        if (provider === primary) {
          throw new Error("Authorization: Bearer private-token");
        }
        return { requestId: "fc_req", creditsUsed: 1 };
      },
    });

    expect(response).toEqual({ requestId: "fc_req", creditsUsed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "web provider attempt failed",
      expect.objectContaining({
        providerId: "primary",
        role: "primary",
        errorMessage: "Authorization: <redacted>",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "web provider fallback starting",
      expect.objectContaining({
        failedProviderId: "primary",
        fallbackProviderId: "fallback",
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "web provider attempt succeeded",
      expect.objectContaining({
        providerId: "fallback",
        role: "fallback",
        fallbackUsed: true,
        requestId: "fc_req",
        creditsUsed: 1,
      }),
    );
  });

  test("does not start fallback after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();

    await expect(
      executeWebProviderChain({
        toolName: "web_fetch",
        context: {
          sessionId: "session_1",
          conversationId: "conversation_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: {} as never,
          abortSignal: controller.signal,
        },
        primary: { providerId: "primary", providerApi: "tavily" },
        fallback: { providerId: "fallback", providerApi: "firecrawl" },
        execute,
      }),
    ).rejects.toMatchObject({
      failures: [
        {
          role: "primary",
          failure: { code: "aborted", retryable: false },
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
