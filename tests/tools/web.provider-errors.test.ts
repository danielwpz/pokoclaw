import { describe, expect, test } from "vitest";

import {
  createHttpProviderError,
  normalizeWebProviderFailure,
  parseRetryAfterMs,
} from "@/src/tools/web/provider-errors.js";

describe("web provider errors", () => {
  test("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("2.5", 0)).toBe(2_500);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfterMs("invalid", 0)).toBeUndefined();
  });

  test("preserves Retry-After from HTTP 429 responses", () => {
    const error = createHttpProviderError(
      429,
      "Rate limit exceeded",
      new Headers({ "Retry-After": "40" }),
    );

    expect(normalizeWebProviderFailure(error)).toEqual({
      code: "rate_limited",
      message: "Rate limit exceeded",
      retryable: true,
      statusCode: 429,
      retryAfterMs: 40_000,
    });
  });

  test("uses the provider error body when Retry-After is unavailable", () => {
    expect(
      normalizeWebProviderFailure(
        createHttpProviderError(
          429,
          "Rate limit exceeded. Please retry after 40s, resets at Sat Sep 19 2026 10:49:43 GMT+0000 (UTC)",
        ),
      ),
    ).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 40_000,
    });
  });

  test("classifies Tavily plan usage exhaustion as a non-retryable quota failure", () => {
    expect(
      normalizeWebProviderFailure(
        new Error(
          "This request exceeds your plan's set usage limit. Please upgrade your plan or contact support.",
        ),
      ),
    ).toMatchObject({
      code: "quota_exhausted",
      retryable: false,
    });
  });
});
