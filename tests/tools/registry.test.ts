import { setTimeout as delay } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "@/src/config/defaults.js";
import type { ToolFailure } from "@/src/tools/core/errors.js";
import { toolApprovalRequired } from "@/src/tools/core/errors.js";
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_NOTICE,
  ToolRegistry,
} from "@/src/tools/core/registry.js";
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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
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
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: expect.stringMatching(/read_file args are invalid/i),
      details: {
        code: "invalid_tool_args",
        toolName: "read_file",
        allowedFields: ["path", "offset"],
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "/path", message: "Expected string" }),
          expect.objectContaining({ path: "/unexpected", message: "Unexpected property" }),
        ]),
      },
    } satisfies Partial<ToolFailure>);

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
    ).rejects.toMatchObject({
      message: expect.stringContaining("Fix the following argument issues:"),
    });

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
    ).rejects.toThrow(/\/path: Expected string\./i);

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
    ).rejects.toThrow(/\/unexpected: Unexpected property\./i);

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
    ).rejects.toThrow(/Allowed fields: path, offset\./i);
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
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "Tool not found: missing",
      details: {
        code: "tool_not_found",
        toolName: "missing",
      },
    } satisfies Partial<ToolFailure>);
  });

  test("truncates oversized text tool results with the global default limit", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry([
      defineTool({
        name: "large_text",
        description: "Return a large text payload",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          return textToolResult("A".repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 500));
        },
      }),
    ]);

    const result = await registry.execute(
      "large_text",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {},
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: `${"A".repeat(DEFAULT_TOOL_RESULT_MAX_CHARS - TOOL_RESULT_TRUNCATION_NOTICE.length)}${TOOL_RESULT_TRUNCATION_NOTICE}`,
    });
  });

  test("truncates oversized json tool results with the global default limit", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry([
      defineTool({
        name: "large_json",
        description: "Return a large json payload",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          return jsonToolResult({
            payload: "B".repeat(DEFAULT_TOOL_RESULT_MAX_CHARS + 500),
          });
        },
      }),
    ]);

    const result = await registry.execute(
      "large_json",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {},
    );

    expect(result.content).toHaveLength(1);
    const firstBlock = result.content[0];
    expect(firstBlock).toBeDefined();
    expect(firstBlock?.type).toBe("text");
    expect((firstBlock as { type: "text"; text: string }).text).toContain(
      TOOL_RESULT_TRUNCATION_NOTICE,
    );
    expect((firstBlock as { type: "text"; text: string }).text.length).toBe(
      DEFAULT_TOOL_RESULT_MAX_CHARS,
    );
  });

  test("honors per-tool result size overrides", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry([
      defineTool({
        name: "small_cap",
        description: "Return a capped payload",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        getResultMaxChars() {
          return 64;
        },
        execute() {
          return textToolResult("C".repeat(200));
        },
      }),
    ]);

    const result = await registry.execute(
      "small_cap",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      {},
    );

    const firstBlock = result.content[0];
    expect(firstBlock).toBeDefined();
    expect(firstBlock).toEqual({
      type: "text",
      text: `${"C".repeat(64 - TOOL_RESULT_TRUNCATION_NOTICE.length)}${TOOL_RESULT_TRUNCATION_NOTICE}`,
    });
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

  test("logs tool execution start and success with truncated args/result", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "bash",
        description: "Run bash",
        inputSchema: Type.Object({
          command: Type.String(),
        }),
        execute() {
          return textToolResult("x".repeat(400));
        },
      }),
    );

    await registry.execute(
      "bash",
      {
        sessionId: "sess_1",
        conversationId: "conv_1",
        toolCallId: "tool_1",
        securityConfig: DEFAULT_CONFIG.security,
        storage: handle.storage.db,
      },
      { command: "echo ".concat("a".repeat(300)) },
    );

    const output = consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain("[tools] tool execution started");
    expect(output).toContain("toolName='bash'");
    expect(output).toContain("toolCallId='tool_1'");
    expect(output).toContain("[tools] tool execution finished");
    expect(output).toContain("success=true");
    expect(output).toContain("durationMs=");
    expect(output).toContain("args=");
    expect(output).toContain("result=");
    expect(output).toContain("...");
  });

  test("logs approval-required tools as waiting for approval", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "bash",
        description: "Run bash",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw toolApprovalRequired({
            request: {
              scopes: [{ kind: "db.read", database: "system" }],
            },
            reasonText: "Need approval first",
          });
        },
      }),
    );

    await expect(
      registry.execute(
        "bash",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          toolCallId: "tool_approval",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {},
      ),
    ).rejects.toMatchObject({
      name: "ToolApprovalRequired",
    });

    const output = consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain("[tools] tool execution waiting for approval");
    expect(output).toContain("toolCallId='tool_approval'");
    expect(output).not.toContain("success=false");
  });

  test("enforces the default 10s timeout for tools at the registry layer", async () => {
    handle = await createTestDatabase(import.meta.url);
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "slow_tool",
        description: "Sleeps for too long",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        async execute(context) {
          await delay(60_000, undefined, { signal: context.abortSignal });
          return textToolResult("done");
        },
      }),
    );

    const execution = expect(
      registry.execute(
        "slow_tool",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {},
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "recoverable_error",
      message: "The slow_tool tool timed out after 10000ms.",
      details: {
        code: "tool_timeout",
        toolName: "slow_tool",
        timeoutMs: 10_000,
      },
    } satisfies Partial<ToolFailure>);

    await vi.advanceTimersByTimeAsync(10_000);

    await execution;
  });

  test("normalizes unexpected tool exceptions into internal tool failures", async () => {
    handle = await createTestDatabase(import.meta.url);
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "fragile",
        description: "Throws unexpectedly",
        inputSchema: NO_ARGS_TOOL_SCHEMA,
        execute() {
          throw new Error("cannot read properties of undefined");
        },
      }),
    );

    await expect(
      registry.execute(
        "fragile",
        {
          sessionId: "sess_1",
          conversationId: "conv_1",
          toolCallId: "tool_fragile",
          securityConfig: DEFAULT_CONFIG.security,
          storage: handle.storage.db,
        },
        {},
      ),
    ).rejects.toMatchObject({
      name: "ToolFailure",
      kind: "internal_error",
      message: "Tool execution failed due to an internal runtime error.",
      rawMessage: "cannot read properties of undefined",
    } satisfies Partial<ToolFailure>);
  });
});
