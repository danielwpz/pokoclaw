import { describe, expect, test } from "vitest";
import { mapCodexResponsesEvents } from "@/src/agent/llm/providers/codex/stream.js";

async function* eventsFrom(events: Array<Record<string, unknown>>) {
  yield* events;
}

async function collectMappedEvents(events: Array<Record<string, unknown>>) {
  const mapped = [];
  for await (const event of mapCodexResponsesEvents(eventsFrom(events))) {
    mapped.push(event);
  }
  return mapped;
}

describe("codex responses stream adapter", () => {
  test("normalizes representative Codex response events for the shared Responses processor", async () => {
    const messageItem = {
      type: "message",
      id: "msg_test",
      content: [{ type: "output_text", text: "ok" }],
    };

    const mapped = await collectMappedEvents([
      {
        type: "response.output_item.added",
        item: { ...messageItem, content: [] },
      },
      {
        type: "response.content_part.added",
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        delta: "ok",
      },
      {
        type: "response.output_item.done",
        item: messageItem,
      },
      {
        type: "response.done",
        response: {
          id: "resp_test",
          status: "completed",
        },
      },
    ]);

    expect(mapped.map((event) => event.type)).toEqual([
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(mapped.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    });
  });

  test("maps failed Codex done events to the shared failure path", async () => {
    const mapped = await collectMappedEvents([
      {
        type: "response.done",
        response: {
          id: "resp_failed",
          status: "failed",
          error: {
            code: "invalid_request_error",
            message: "duplicate item id",
          },
        },
      },
    ]);

    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          code: "invalid_request_error",
          message: "duplicate item id",
        },
      },
    });
  });

  test("continues consuming events after a terminal Codex event", async () => {
    const mapped = await collectMappedEvents([
      {
        type: "response.done",
        response: {
          id: "resp_test",
          status: "completed",
        },
      },
      {
        type: "response.output_text.delta",
        delta: "late metadata",
      },
    ]);

    expect(mapped.map((event) => event.type)).toEqual([
      "response.completed",
      "response.output_text.delta",
    ]);
  });

  test("rejects malformed critical Codex events at the adapter boundary", async () => {
    await expect(
      collectMappedEvents([
        {
          type: "response.output_text.delta",
          delta: 123,
        },
      ]),
    ).rejects.toThrow("Invalid Codex response.output_text.delta event");
  });

  test("requires a known status on Codex done events", async () => {
    await expect(
      collectMappedEvents([
        {
          type: "response.done",
          response: {
            id: "resp_missing_status",
          },
        },
      ]),
    ).rejects.toThrow("Invalid Codex response.done event: response.status is required");
  });

  test("requires finalized message content on Codex output item done events", async () => {
    await expect(
      collectMappedEvents([
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_missing_content",
          },
        },
      ]),
    ).rejects.toThrow("Invalid Codex response.output_item.done event: item.content is required");
  });

  test("requires finalized reasoning summary on Codex output item done events", async () => {
    await expect(
      collectMappedEvents([
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_missing_summary",
          },
        },
      ]),
    ).rejects.toThrow("Invalid Codex response.output_item.done event: item.summary is required");
  });

  test("validates shared fields on unknown Codex output item types", async () => {
    await expect(
      collectMappedEvents([
        {
          type: "response.output_item.added",
          item: {
            type: "custom_item",
            id: 123,
          },
        },
      ]),
    ).rejects.toThrow("Invalid Codex response.output_item.added event: item.id must be a string");
  });
});
