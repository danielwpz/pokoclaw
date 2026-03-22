import { afterEach, describe, expect, test } from "vitest";

import { ToolRegistry } from "@/src/agent/tools/registry.js";
import { jsonToolResult, textToolResult } from "@/src/agent/tools/types.js";
import { createTestLogger } from "@/src/shared/logger.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("tool registry", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("registers and executes a validated read_file tool", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry();
    const logger = createTestLogger(
      { level: "debug", useColors: false },
      { subsystem: "test-tools" },
    );

    registry.register({
      name: "read_file",
      description: "Read a file from disk",
      validateArgs(input) {
        if (
          typeof input !== "object" ||
          input == null ||
          !("path" in input) ||
          typeof input.path !== "string"
        ) {
          throw new Error("invalid args");
        }

        return {
          path: input.path,
          offset: "offset" in input && typeof input.offset === "number" ? input.offset : 0,
        };
      },
      execute(context, args: { path: string; offset: number }) {
        return jsonToolResult(
          {
            path: args.path,
            text: "file contents",
            sessionId: context.sessionId,
          },
          { offset: args.offset, bytesRead: 13 },
        );
      },
    });

    const result = await registry.execute(
      "read_file",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        storage: handle.storage.db,
        logger,
      },
      { path: "/workspace/README.md", offset: 0 },
    );

    expect(result).toEqual({
      content: [
        {
          type: "json",
          json: {
            path: "/workspace/README.md",
            text: "file contents",
            sessionId: "sess_1",
          },
        },
      ],
      details: { offset: 0, bytesRead: 13 },
    });
  });

  test("rejects duplicate registrations and missing tools", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry([
      {
        name: "bash",
        description: "Run a shell command",
        execute() {
          return textToolResult("ok");
        },
      },
    ]);

    expect(() =>
      registry.register({
        name: "bash",
        description: "Duplicate",
        execute() {
          return textToolResult("nope");
        },
      }),
    ).toThrow("Tool already registered: bash");

    await expect(
      registry.execute(
        "missing",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          storage: handle.storage.db,
          logger: createTestLogger(
            { level: "debug", useColors: false },
            { subsystem: "test-tools" },
          ),
        },
        {},
      ),
    ).rejects.toThrow("Tool not found: missing");
  });

  test("tool result helpers build text and json payloads", () => {
    expect(textToolResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });

    expect(jsonToolResult({ ok: true }, { code: 200 })).toEqual({
      content: [{ type: "json", json: { ok: true } }],
      details: { code: 200 },
    });
  });
});
