import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import { ToolRegistry } from "@/src/tools/core/registry.js";
import { defineTool, jsonToolResult, textToolResult } from "@/src/tools/core/types.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

const READ_FILE_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String(),
    offset: Type.Optional(Type.Number({ default: 0 })),
  },
  { additionalProperties: false },
);

const NO_ARGS_TOOL_SCHEMA = Type.Object({}, { additionalProperties: false });

describe("tool registry", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("registers and executes a schema-defined read_file tool with defaults", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: READ_FILE_TOOL_SCHEMA,
        execute(context, args) {
          return jsonToolResult(
            {
              path: args.path,
              text: "file contents",
              sessionId: context.sessionId,
            },
            { offset: args.offset, bytesRead: 13 },
          );
        },
      }),
    );

    const result = await registry.execute(
      "read_file",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      { path: "/workspace/README.md" },
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

  test("rejects invalid tool args from the declared schema", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry();

    registry.register(
      defineTool({
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: READ_FILE_TOOL_SCHEMA,
        execute() {
          return textToolResult("ok");
        },
      }),
    );

    await expect(
      registry.execute(
        "read_file",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        { path: 123, unexpected: true },
      ),
    ).rejects.toThrow(/read_file args are invalid/i);
  });

  test("rejects duplicate registrations and missing tools", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry([
      defineTool({
        name: "bash",
        description: "Run a shell command",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          return textToolResult("ok");
        },
      }),
    ]);

    expect(() =>
      registry.register(
        defineTool({
          name: "bash",
          description: "Duplicate",
          inputSchema: NO_ARGS_TOOL_SCHEMA,
          execute() {
            return textToolResult("nope");
          },
        }),
      ),
    ).toThrow("Tool already registered: bash");

    await expect(
      registry.execute(
        "missing",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
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
