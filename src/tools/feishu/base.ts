/**
 * feishu_base tool - Read and write Feishu/Lark Base (多维表格 / Bitable).
 *
 * Uses the Feishu Open Platform Bitable API to access tables, fields,
 * and records. Requires the app to have base permissions.
 */
import { type Static, Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult } from "@/src/tools/core/types.js";
import { extractFeishuData, type FeishuClientSource } from "@/src/tools/feishu/client.js";

const logger = createSubsystemLogger("tools/feishu-base");

const FEISHU_BASE_SCHEMA = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("get_info"),
        Type.Literal("list_tables"),
        Type.Literal("list_fields"),
        Type.Literal("list_records"),
        Type.Literal("search_records"),
        Type.Literal("create_record"),
        Type.Literal("update_record"),
        Type.Literal("create_records"),
        Type.Literal("update_records"),
        Type.Literal("create_base"),
        Type.Literal("create_table"),
      ],
      { description: "Operation to perform on the base." },
    ),
    app_token: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "The base app token. Obtain from the base URL: https://xxx.feishu.cn/base/TOKEN or from wiki node token. Not needed for create_base action.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Base name for create_base, or table name for create_table.",
      }),
    ),
    folder_token: Type.Optional(
      Type.String({
        description: "Folder token to create the base in. Optional for create_base.",
      }),
    ),
    default_view_name: Type.Optional(
      Type.String({
        description: "Default view name for the table. Optional for create_table.",
      }),
    ),
    table_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Table ID. Required for table-scoped actions. Obtain from URL or list_tables.",
      }),
    ),
    record_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Record ID. Required for update_record.",
      }),
    ),
    fields: Type.Optional(
      Type.Record(Type.String(), Type.Any(), {
        description:
          "Field values as a key-value map for create_record/update_record. " +
          "Text: string, Number: number, Select/MultiSelect: string/string[], " +
          "Person: [{id:'open_id'}], Attachment: [{file_token:'...'}], etc.",
      }),
    ),
    records: Type.Optional(
      Type.Array(
        Type.Object(
          {
            record_id: Type.Optional(
              Type.String({ description: "Record ID (required for update_records)." }),
            ),
            fields: Type.Record(Type.String(), Type.Any(), {
              description: "Field values for this record.",
            }),
          },
          { additionalProperties: false },
        ),
        { description: "Array of records for create_records/update_records batch operations." },
      ),
    ),
    table_fields: Type.Optional(
      Type.Array(
        Type.Object(
          {
            field_name: Type.String({ minLength: 1, description: "Field name." }),
            type: Type.Number({
              description:
                "Field type number. 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=Attachment, 13=DuplexLink, 17=Location, 21=Barcode, 22=Phone, 23=Email, 1001=Formula, etc.",
            }),
            ui_type: Type.Optional(
              Type.String({
                description:
                  "UI type: 'Text', 'Number', 'SingleSelect', 'MultiSelect', 'DateTime', 'Checkbox', 'Attachment', etc.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { description: "Field definitions for create_table action." },
      ),
    ),
    filter: Type.Optional(
      Type.Any({
        description: "Filter for search_records. Object with conjunction, conditions, etc.",
      }),
    ),
    sort: Type.Optional(
      Type.Array(
        Type.Object(
          {
            field_name: Type.String({ minLength: 1 }),
            desc: Type.Optional(Type.Boolean({ description: "Sort descending if true." })),
          },
          { additionalProperties: false },
        ),
        { description: "Sort order for list_records/search_records." },
      ),
    ),
    page_size: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 500,
        description: "Page size for list actions (default 100, max 500).",
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: "Page token for paginated list actions.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type FeishuBaseArgs = Static<typeof FEISHU_BASE_SCHEMA>;

export function createFeishuBaseTool(input: {
  installationId: string;
  clientSource: FeishuClientSource;
}) {
  const client = input.clientSource.getClient(input.installationId);

  return defineTool({
    name: "feishu_base",
    description:
      "Read and write Feishu/Lark Base (多维表格 / Bitable). " +
      "Actions: get_info (app metadata), list_tables, list_fields, " +
      "list_records (paginated), search_records (with filter/sort), " +
      "create_record, update_record, create_records (batch), update_records (batch), " +
      "create_base (create a new base), create_table (create a new table in a base).",
    inputSchema: FEISHU_BASE_SCHEMA,
    getInvocationTimeoutMs() {
      return 30_000;
    },
    async execute(_context, args) {
      logger.info("executing feishu_base", {
        action: args.action,
        appToken: args.app_token,
      });

      try {
        // biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
        const bitable = client.bitable as any;

        switch (args.action) {
          case "get_info":
            return await handleGetAppInfo(bitable, args);
          case "list_tables":
            return await handleListTables(bitable, args);
          case "list_fields":
            return await handleListFields(bitable, args);
          case "list_records":
            return await handleListRecords(bitable, args);
          case "search_records":
            return await handleSearchRecords(bitable, args);
          case "create_record":
            return await handleCreateRecord(bitable, args);
          case "update_record":
            return await handleUpdateRecord(bitable, args);
          case "create_records":
            return await handleCreateRecords(bitable, args);
          case "update_records":
            return await handleUpdateRecords(bitable, args);
          case "create_base":
            return await handleCreateBase(bitable, args);
          case "create_table":
            return await handleCreateTable(bitable, args);
          default:
            throw toolRecoverableError(`Unknown action: ${(args as { action: string }).action}`, {
              code: "feishu_base_unknown_action",
            });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "ToolRecoverableError") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);

        // Extract Feishu API error details from axios response
        let detail = "";
        const axiosErr = error as { response?: { data?: unknown } };
        if (axiosErr.response?.data) {
          try {
            detail = ` | detail: ${JSON.stringify(axiosErr.response.data)}`;
          } catch {
            // ignore
          }
        }

        throw toolRecoverableError(`feishu_base failed: ${message}${detail}`, {
          code: "feishu_base_error",
        });
      }
    },
  });
}

function requireAppToken(args: FeishuBaseArgs): string {
  if (!args.app_token) {
    throw toolRecoverableError("app_token is required for this action", {
      code: "feishu_base_missing_app_token",
    });
  }
  return args.app_token;
}

function requireTableId(args: FeishuBaseArgs): string {
  if (!args.table_id) {
    throw toolRecoverableError("table_id is required for this action", {
      code: "feishu_base_missing_table_id",
    });
  }
  return args.table_id;
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleGetAppInfo(bitable: any, args: FeishuBaseArgs) {
  const result = await bitable.app.get({
    path: { app_token: requireAppToken(args) },
  });
  return jsonToolResult(extractFeishuData(result, "get_info"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleListTables(bitable: any, args: FeishuBaseArgs) {
  const result = await bitable.appTable.list({
    path: { app_token: requireAppToken(args) },
    params: {
      page_size: args.page_size ?? 100,
      ...(args.page_token ? { page_token: args.page_token } : {}),
    },
  });
  return jsonToolResult(extractFeishuData(result, "list_tables"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleListFields(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  const result = await bitable.appTableField.list({
    path: { app_token: requireAppToken(args), table_id: tableId },
    params: {
      page_size: args.page_size ?? 100,
      ...(args.page_token ? { page_token: args.page_token } : {}),
    },
  });
  return jsonToolResult(extractFeishuData(result, "list_fields"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleListRecords(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  const params: Record<string, number | string> = {
    page_size: args.page_size ?? 100,
  };
  if (args.page_token) params.page_token = args.page_token;
  if (args.sort && args.sort.length > 0) {
    params.sort = JSON.stringify(args.sort);
  }

  const result = await bitable.appTableRecord.list({
    path: { app_token: requireAppToken(args), table_id: tableId },
    params,
  });
  return jsonToolResult(extractFeishuData(result, "list_records"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleSearchRecords(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  const data: Record<string, unknown> = {};
  if (args.filter) data.filter = args.filter;
  if (args.sort && args.sort.length > 0) data.sort = args.sort;

  const result = await bitable.appTableRecord.search({
    path: { app_token: requireAppToken(args), table_id: tableId },
    params: {
      page_size: args.page_size ?? 100,
      ...(args.page_token ? { page_token: args.page_token } : {}),
    },
    data,
  });
  return jsonToolResult(extractFeishuData(result, "search_records"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleCreateRecord(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  if (!args.fields) {
    throw toolRecoverableError("fields are required for create_record", {
      code: "feishu_base_missing_fields",
    });
  }

  const result = await bitable.appTableRecord.create({
    path: { app_token: requireAppToken(args), table_id: tableId },
    data: { fields: args.fields },
  });
  return jsonToolResult(extractFeishuData(result, "create_record"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleUpdateRecord(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  if (!args.record_id) {
    throw toolRecoverableError("record_id is required for update_record", {
      code: "feishu_base_missing_record_id",
    });
  }
  if (!args.fields) {
    throw toolRecoverableError("fields are required for update_record", {
      code: "feishu_base_missing_fields",
    });
  }

  const result = await bitable.appTableRecord.update({
    path: { app_token: requireAppToken(args), table_id: tableId, record_id: args.record_id },
    data: { fields: args.fields },
  });
  return jsonToolResult(extractFeishuData(result, "update_record"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleCreateRecords(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  if (!args.records || args.records.length === 0) {
    throw toolRecoverableError("records are required for create_records", {
      code: "feishu_base_missing_records",
    });
  }

  const records = args.records.map((r) => ({ fields: r.fields }));

  const result = await bitable.appTableRecord.batchCreate({
    path: { app_token: requireAppToken(args), table_id: tableId },
    data: { records },
  });
  return jsonToolResult(extractFeishuData(result, "create_records"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleUpdateRecords(bitable: any, args: FeishuBaseArgs) {
  const tableId = requireTableId(args);
  if (!args.records || args.records.length === 0) {
    throw toolRecoverableError("records are required for update_records", {
      code: "feishu_base_missing_records",
    });
  }

  const records = args.records.map((r, i) => {
    if (!r.record_id) {
      throw toolRecoverableError(`records[${i}].record_id is required for update_records`, {
        code: "feishu_base_missing_record_id_in_batch",
      });
    }
    return { record_id: r.record_id, fields: r.fields };
  });

  const result = await bitable.appTableRecord.batchUpdate({
    path: { app_token: requireAppToken(args), table_id: tableId },
    data: { records },
  });
  return jsonToolResult(extractFeishuData(result, "update_records"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleCreateBase(bitable: any, args: FeishuBaseArgs) {
  if (!args.name) {
    throw toolRecoverableError("name is required for create_base", {
      code: "feishu_base_missing_name",
    });
  }

  const result = await bitable.app.create({
    data: {
      name: args.name,
      ...(args.folder_token ? { folder_token: args.folder_token } : {}),
    },
  });
  return jsonToolResult(extractFeishuData(result, "create_base"));
}

// biome-ignore lint/suspicious/noExplicitAny: bitable SDK types are structurally incompatible
async function handleCreateTable(bitable: any, args: FeishuBaseArgs) {
  const appToken = requireAppToken(args);
  if (!args.name) {
    throw toolRecoverableError("name is required for create_table", {
      code: "feishu_base_missing_name",
    });
  }

  const tableData: Record<string, unknown> = { name: args.name };
  if (args.default_view_name) tableData.default_view_name = args.default_view_name;
  if (args.table_fields && args.table_fields.length > 0) {
    tableData.fields = args.table_fields.map((f) => ({
      field_name: f.field_name,
      type: f.type,
      ...(f.ui_type ? { ui_type: f.ui_type } : {}),
    }));
  }

  const result = await bitable.appTable.create({
    path: { app_token: appToken },
    data: { table: tableData },
  });
  return jsonToolResult(extractFeishuData(result, "create_table"));
}
