import { describe, expect, test, vi } from "vitest";

import { WebProviderError } from "@/src/tools/web/provider-errors.js";
import { WebProviderGovernor } from "@/src/tools/web/provider-governor.js";

describe("web provider governor", () => {
  test("waits for Retry-After inside the host and retries once", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const governor = new WebProviderGovernor({
      clock: { now: () => now, sleep },
      rateLimitJitterMs: 0,
    });
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new WebProviderError({
          code: "rate_limited",
          message: "slow down",
          retryable: true,
          statusCode: 429,
          retryAfterMs: 5_000,
        }),
      )
      .mockResolvedValueOnce("ok");

    await expect(
      governor.execute({
        toolName: "web_search",
        providerId: "firecrawl",
        providerApi: "firecrawl",
        waitForRateLimit: true,
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
  });

  test("records cooldown without waiting when a fallback can run", async () => {
    let now = 10_000;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const governor = new WebProviderGovernor({
      clock: { now: () => now, sleep },
      rateLimitJitterMs: 0,
    });
    const rateLimited = new WebProviderError({
      code: "rate_limited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 4_000,
    });

    await expect(
      governor.execute({
        toolName: "web_search",
        providerId: "primary",
        providerApi: "firecrawl",
        waitForRateLimit: false,
        execute: async () => {
          throw rateLimited;
        },
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(sleep).not.toHaveBeenCalled();

    const retry = vi.fn(async () => "ok");
    await expect(
      governor.execute({
        toolName: "web_search",
        providerId: "primary",
        providerApi: "firecrawl",
        waitForRateLimit: true,
        execute: retry,
      }),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(4_000, undefined);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent requests for the same provider capability", async () => {
    const governor = new WebProviderGovernor();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = governor.execute({
      toolName: "web_search",
      providerId: "firecrawl",
      providerApi: "firecrawl",
      waitForRateLimit: true,
      execute: async () => {
        order.push("first-start");
        await firstGate;
        order.push("first-end");
        return "first";
      },
    });
    const second = governor.execute({
      toolName: "web_search",
      providerId: "firecrawl",
      providerApi: "firecrawl",
      waitForRateLimit: true,
      execute: async () => {
        order.push("second-start");
        return "second";
      },
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("temporarily skips a quota-exhausted provider across capabilities", async () => {
    let now = 0;
    const governor = new WebProviderGovernor({
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      providerReprobeMs: 60_000,
    });

    await expect(
      governor.execute({
        toolName: "web_search",
        providerId: "tavily",
        providerApi: "tavily",
        waitForRateLimit: false,
        execute: async () => {
          throw new Error("This request exceeds your plan's set usage limit.");
        },
      }),
    ).rejects.toMatchObject({ code: "quota_exhausted", retryable: false });

    const fetch = vi.fn(async () => "should-not-run");
    await expect(
      governor.execute({
        toolName: "web_fetch",
        providerId: "tavily",
        providerApi: "tavily",
        waitForRateLimit: false,
        execute: fetch,
      }),
    ).rejects.toMatchObject({ code: "quota_exhausted", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("removes an aborted request from the provider queue", async () => {
    const governor = new WebProviderGovernor();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = governor.execute({
      toolName: "web_fetch",
      providerId: "firecrawl",
      providerApi: "firecrawl",
      waitForRateLimit: true,
      execute: async () => {
        await firstGate;
        return "first";
      },
    });
    const controller = new AbortController();
    const queuedExecute = vi.fn(async () => "second");
    const queued = governor.execute({
      toolName: "web_fetch",
      providerId: "firecrawl",
      providerApi: "firecrawl",
      signal: controller.signal,
      waitForRateLimit: true,
      execute: queuedExecute,
    });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(queuedExecute).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toBe("first");
  });
});
