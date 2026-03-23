import { describe, expect, test } from "vitest";

import { SessionRunAbortRegistry } from "@/src/runtime/cancel.js";

describe("session run abort registry", () => {
  test("tracks active runs and aborts them by session", () => {
    const registry = new SessionRunAbortRegistry();
    const handle = registry.begin("sess_1");

    expect(registry.isActive("sess_1")).toBe(true);
    expect(registry.getSignal("sess_1")?.aborted).toBe(false);

    expect(registry.cancel("sess_1", "stop requested")).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(registry.isActive("sess_1")).toBe(false);
  });

  test("rejects duplicate runs for the same session and allows restart after finish", () => {
    const registry = new SessionRunAbortRegistry();
    const handle = registry.begin("sess_1");

    expect(() => registry.begin("sess_1")).toThrow("Session already has an active run: sess_1");

    handle.finish();
    expect(registry.isActive("sess_1")).toBe(false);

    const nextHandle = registry.begin("sess_1");
    expect(nextHandle.signal.aborted).toBe(false);
  });
});
