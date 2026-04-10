import { describe, expect, test } from "vitest";

import {
  buildToolFailureContent,
  normalizeToolFailure,
  toolFatalError,
  toolInternalError,
  toolRecoverableError,
} from "@/src/tools/core/errors.js";

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
    expect(error.shouldReturnToLlm).toBe(true);
    expect(error.retryable).toBe(false);
  });

  test("keeps fatal tool errors as run-terminating", () => {
    const error = toolFatalError("host runtime is inconsistent");

    expect(error.kind).toBe("fatal_error");
    expect(error.message).toBe("host runtime is inconsistent");
    expect(error.shouldReturnToLlm).toBe(false);
    expect(error.retryable).toBe(false);
  });

  test("keeps raw internal runtime details when normalizing unexpected tool errors", () => {
    const error = normalizeToolFailure(
      new Error("EPERM: operation not permitted, scandir '/Users/example/.Trash'"),
    );

    expect(error.kind).toBe("internal_error");
    expect(error.message).toBe("Tool execution failed due to an internal runtime error.");
    expect(error.rawMessage).toBe(
      "EPERM: operation not permitted, scandir '/Users/example/.Trash'",
    );
    expect(buildToolFailureContent(error)).toEqual([
      {
        type: "text",
        text: "Tool execution failed due to an internal runtime error.\n\nRaw error: EPERM: operation not permitted, scandir '/Users/example/.Trash'",
      },
    ]);
  });
});
