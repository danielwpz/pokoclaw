import { describe, expect, test } from "vitest";
import { normalizeAgentLlmError } from "@/src/agent/llm/errors.js";

describe("normalizeAgentLlmError", () => {
  test("prefers structured http status over generic message matching", () => {
    const error = Object.assign(new Error("provider rejected request"), {
      status: 404,
    });

    expect(normalizeAgentLlmError({ error })).toMatchObject({
      kind: "upstream",
      retryable: false,
      message: "provider rejected request",
    });
  });

  test("maps nested response status codes before falling back to message parsing", () => {
    const error = Object.assign(new Error("request failed"), {
      response: { status: 429 },
    });

    expect(normalizeAgentLlmError({ error })).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      message: "request failed",
    });
  });

  test("treats 403 upstream rejections as non-retryable", () => {
    const error = Object.assign(new Error("This model is not available in your region."), {
      cause: { statusCode: 403 },
    });

    expect(normalizeAgentLlmError({ error })).toMatchObject({
      kind: "upstream",
      retryable: false,
    });
  });

  test("still extracts http status codes from provider-thrown strings", () => {
    expect(
      normalizeAgentLlmError({
        error: new Error("Cloud Code Assist API error (404): model not found"),
      }),
    ).toMatchObject({
      kind: "upstream",
      retryable: false,
      message: "Cloud Code Assist API error (404): model not found",
    });
  });

  test("falls back to semantic message classification when no code is present", () => {
    expect(
      normalizeAgentLlmError({
        error: new Error("prompt is too long: 213462 tokens > 200000 maximum"),
      }),
    ).toMatchObject({
      kind: "context_overflow",
      retryable: false,
    });
  });

  test("classifies provider-style 400 context window errors as context overflow", () => {
    const error = Object.assign(
      new Error(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"},"request_id":"req_123"}',
      ),
      {
        status: 400,
      },
    );

    expect(normalizeAgentLlmError({ error })).toMatchObject({
      kind: "context_overflow",
      retryable: false,
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"},"request_id":"req_123"}',
    });
  });

  test("treats 5xx responses as retryable upstream overloads", () => {
    const error = Object.assign(new Error("Service unavailable"), {
      statusCode: 503,
    });

    expect(normalizeAgentLlmError({ error })).toMatchObject({
      kind: "overloaded",
      retryable: true,
    });
  });
});
