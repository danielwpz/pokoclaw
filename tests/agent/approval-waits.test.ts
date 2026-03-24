import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionApprovalWaitRegistry } from "@/src/runtime/approval-waits.js";

describe("session approval wait registry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves approval waits and returns queued steer inputs", async () => {
    const registry = new SessionApprovalWaitRegistry();
    const waitPromise = registry.beginWait({
      sessionId: "sess_1",
      approvalId: 12,
      timeoutMs: 5_000,
    });

    expect(
      registry.enqueueSteer({
        sessionId: "sess_1",
        content: "After this, summarize the result.",
      }),
    ).toBe(true);
    expect(
      registry.resolveApproval({
        approvalId: 12,
        decision: "approve",
        actor: "user",
        grantedBy: "user",
        rawInput: "approve",
        expiresAt: null,
      }),
    ).toBe(true);

    await expect(waitPromise).resolves.toMatchObject({
      decision: "approve",
      actor: "user",
      grantedBy: "user",
      rawInput: "approve",
      expiresAt: null,
      queuedSteer: [{ content: "After this, summarize the result." }],
    });
  });

  test("times out as a deny result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T00:03:00.000Z"));

    const registry = new SessionApprovalWaitRegistry();
    const waitPromise = registry.beginWait({
      sessionId: "sess_1",
      approvalId: 13,
      timeoutMs: 180_000,
    });

    await vi.advanceTimersByTimeAsync(180_000);

    await expect(waitPromise).resolves.toMatchObject({
      decision: "deny",
      actor: "system:timeout",
      reasonText: "Approval request timed out.",
      decidedAt: new Date("2026-03-23T00:06:00.000Z"),
      queuedSteer: [],
    });
  });

  test("cancels a pending wait by session", async () => {
    const registry = new SessionApprovalWaitRegistry();
    const waitPromise = registry.beginWait({
      sessionId: "sess_1",
      approvalId: 14,
      timeoutMs: 5_000,
    });

    expect(
      registry.cancelSession({
        sessionId: "sess_1",
        actor: "system:cancel",
        reasonText: "Cancelled while the run was shutting down.",
      }),
    ).toBe(true);

    await expect(waitPromise).resolves.toMatchObject({
      decision: "deny",
      actor: "system:cancel",
      reasonText: "Cancelled while the run was shutting down.",
      queuedSteer: [],
    });
  });
});
