import { describe, expect, test } from "vitest";

import { toolInternalError, toolRecoverableError } from "@/src/agent/tools/errors.js";

describe("tool errors", () => {
  test("derives recoverable tool error behavior from kind", () => {
    const error = toolRecoverableError("file not found");

    expect(error.kind).toBe("recoverable_error");
    expect(error.message).toBe("file not found");
    expect(error.shouldReturnToLlm).toBe(true);
    expect(error.retryable).toBe(false);
  });

  test("derives internal tool error behavior from kind", () => {
    const error = toolInternalError("runtime blew up");

    expect(error.kind).toBe("internal_error");
    expect(error.message).toBe("runtime blew up");
    expect(error.shouldReturnToLlm).toBe(false);
    expect(error.retryable).toBe(false);
  });
});
