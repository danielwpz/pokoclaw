import { type Static, Type } from "@sinclair/typebox";
import Database from "better-sqlite3";

import { buildSystemPolicy } from "@/src/security/policy.js";
import { SecurityService } from "@/src/security/service.js";
import { getProductionDatabasePath } from "@/src/storage/db/paths.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { resolveToolOwnerAgentId } from "@/src/tools/helpers/common.js";

const MAX_RESULT_ROWS = 2_000;
const MAX_RESULT_CHARS = 256_000;

export const QUERY_SYSTEM_DB_TOOL_SCHEMA = Type.Object(
  {
    sql: Type.String({
      minLength: 1,
      description: "A SQL statement to run against pokeclaw's read-only system SQLite database.",
    }),
  },
  { additionalProperties: false },
);

export type QuerySystemDbToolArgs = Static<typeof QUERY_SYSTEM_DB_TOOL_SCHEMA>;

export function createQuerySystemDbTool() {
  return defineTool({
    name: "query_system_db",
    description:
      "Run a SQL query against pokeclaw's read-only system SQLite database for diagnostics and observability.",
    inputSchema: QUERY_SYSTEM_DB_TOOL_SCHEMA,
    execute(context, args) {
      const ownerAgentId = resolveToolOwnerAgentId(context);
      const security = new SecurityService(
        context.storage,
        buildSystemPolicy({ security: context.securityConfig }),
      );
      const access = security.checkDatabaseAccess({
        ownerAgentId,
        kind: "db.read",
      });
      if (access.result !== "allow") {
        throw toolRecoverableError(access.summary, {
          code: "db_read_not_granted",
          kind: "db.read",
        });
      }

      const databasePath = context.systemDatabasePath ?? getProductionDatabasePath();
      let sqlite: Database.Database | null = null;

      try {
        sqlite = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
        });

        const statement = sqlite.prepare(args.sql);
        const columns = statement.columns().map((column) => column.name);

        if (!statement.reader) {
          const info = statement.run();
          return jsonToolResult({
            columns,
            rows: [],
            rowCount: 0,
            truncated: false,
            execution: {
              changes: info.changes,
            },
          });
        }

        const rawRows = statement.all() as Array<Record<string, unknown>>;
        const normalizedRows = rawRows.map((row) => normalizeSqlRow(row));
        const limited = limitQueryRows(normalizedRows);

        return jsonToolResult({
          columns,
          rows: limited.rows,
          rowCount: normalizedRows.length,
          returnedRowCount: limited.rows.length,
          truncated: limited.truncated,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw toolRecoverableError(`System DB query failed: ${message}`, {
          code: "system_db_query_failed",
          databasePath,
        });
      } finally {
        sqlite?.close();
      }
    },
  });
}

function limitQueryRows(rows: Array<Record<string, unknown>>): {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  let limitedRows = rows.slice(0, MAX_RESULT_ROWS);
  let truncated = limitedRows.length < rows.length;

  while (limitedRows.length > 0 && serializedLength({ rows: limitedRows }) > MAX_RESULT_CHARS) {
    limitedRows = limitedRows.slice(0, -1);
    truncated = true;
  }

  return {
    rows: limitedRows,
    truncated,
  };
}

function normalizeSqlRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)]),
  );
}

function normalizeSqlValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return `<Buffer ${value.byteLength} bytes>`;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
