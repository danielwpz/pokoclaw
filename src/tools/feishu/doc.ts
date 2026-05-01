/**
 * feishu_doc tool - Read and write Feishu/Lark documents.
 *
 * Uses the Feishu Open Platform Docx API to access document content,
 * blocks, and metadata. Requires the app to have document permissions.
 */
import { type Static, Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import { toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, jsonToolResult, textToolResult } from "@/src/tools/core/types.js";
import { extractFeishuData, type FeishuClientSource } from "@/src/tools/feishu/client.js";

const logger = createSubsystemLogger("tools/feishu-doc");

const FEISHU_DOC_SCHEMA = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("get_info"),
        Type.Literal("get_raw_content"),
        Type.Literal("get_blocks"),
        Type.Literal("get_block"),
        Type.Literal("get_children"),
        Type.Literal("create"),
        Type.Literal("create_blocks"),
        Type.Literal("update_block"),
      ],
      { description: "Operation to perform on the document." },
    ),
    document_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "The document ID (token). Obtain from the document URL: https://xxx.feishu.cn/docx/TOKEN. Not needed for create action.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Document title. Required for create action.",
      }),
    ),
    folder_token: Type.Optional(
      Type.String({
        description: "Folder token to create the document in. Optional for create action.",
      }),
    ),
    block_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Block ID. Required for get_block, get_children, create_blocks, update_block.",
      }),
    ),
    blocks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            block_type: Type.String({
              description:
                "Block type: 'text', 'heading1'-'heading7', 'bullet', 'ordered', 'code', 'quote', 'todo', 'divider', 'image', 'table'.",
            }),
            text: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    content: Type.String({ minLength: 1 }),
                    bold: Type.Optional(Type.Boolean({ description: "Bold text" })),
                    italic: Type.Optional(Type.Boolean({ description: "Italic text" })),
                    underline: Type.Optional(Type.Boolean({ description: "Underlined text" })),
                    strikethrough: Type.Optional(
                      Type.Boolean({ description: "Strikethrough text" }),
                    ),
                    inline_code: Type.Optional(Type.Boolean({ description: "Inline code style" })),
                    link: Type.Optional(Type.String({ description: "Hyperlink URL" })),
                  },
                  { additionalProperties: false },
                ),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    update_text_elements: Type.Optional(
      Type.Object(
        {
          elements: Type.Array(
            Type.Object(
              {
                text_run: Type.Object(
                  {
                    content: Type.String({ minLength: 1 }),
                    text_element_style: Type.Optional(
                      Type.Object(
                        {
                          bold: Type.Optional(Type.Boolean({ description: "Bold" })),
                          italic: Type.Optional(Type.Boolean({ description: "Italic" })),
                          underline: Type.Optional(Type.Boolean({ description: "Underline" })),
                          strikethrough: Type.Optional(
                            Type.Boolean({ description: "Strikethrough" }),
                          ),
                          inline_code: Type.Optional(Type.Boolean({ description: "Inline code" })),
                          link: Type.Optional(
                            Type.Object(
                              { url: Type.String({ minLength: 1 }) },
                              { additionalProperties: false },
                            ),
                          ),
                        },
                        { additionalProperties: false },
                      ),
                    ),
                  },
                  { additionalProperties: false },
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    page_size: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 500,
        description: "Page size for paginated list actions (default 50).",
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

export type FeishuDocArgs = Static<typeof FEISHU_DOC_SCHEMA>;
type ApiResult<T = unknown> = { code: number; msg: string; data?: T };

type DocBlockChildrenApi = {
  get: (payload: {
    path: { document_id: string; block_id: string };
    params?: Record<string, string>;
  }) => Promise<ApiResult<{ items?: unknown[]; has_more?: boolean; page_token?: string }>>;
  create: (payload: {
    path: { document_id: string; block_id: string };
    data: { children: unknown[] };
  }) => Promise<ApiResult<{ children?: unknown[] }>>;
};

export function createFeishuDocTool(input: {
  installationId: string;
  clientSource: FeishuClientSource;
}) {
  const client = input.clientSource.getClient(input.installationId);

  return defineTool({
    name: "feishu_doc",
    description:
      "Read and write Feishu/Lark documents (Docx). " +
      "Actions: get_info (document metadata), get_raw_content (plain text), " +
      "get_blocks (list blocks with pagination), get_block (single block), " +
      "get_children (child blocks of a block), create (create a new document), " +
      "create_blocks (add blocks under a parent), update_block (update block text content). " +
      "Block types: text, heading1-7, bullet, ordered, code, quote, todo.",
    inputSchema: FEISHU_DOC_SCHEMA,
    getInvocationTimeoutMs() {
      return 30_000;
    },
    async execute(_context, args) {
      logger.info("executing feishu_doc", {
        action: args.action,
        documentId: requireDocumentId(args),
      });

      try {
        const docx = client.docx as unknown as {
          document: {
            get: (payload: {
              path: { document_id: string };
            }) => Promise<ApiResult<{ document?: unknown }>>;
            rawContent: (payload: {
              path: { document_id: string };
            }) => Promise<ApiResult<{ content?: string }>>;
            create: (payload?: {
              data?: { title?: string; folder_token?: string };
            }) => Promise<ApiResult<{ document?: { document_id?: string; title?: string } }>>;
          };
          documentBlock: {
            list: (payload: {
              path: { document_id: string };
              params: Record<string, string>;
            }) => Promise<
              ApiResult<{ items?: unknown[]; has_more?: boolean; page_token?: string }>
            >;
            get: (payload: {
              path: { document_id: string; block_id: string };
            }) => Promise<ApiResult<{ block?: unknown }>>;
            patch: (payload: {
              path: { document_id: string; block_id: string };
              data: Record<string, unknown>;
            }) => Promise<ApiResult<{ block?: unknown }>>;
            children: DocBlockChildrenApi;
          };
        };

        switch (args.action) {
          case "get_info":
            return await handleGetInfo(docx, args);
          case "get_raw_content":
            return await handleGetRawContent(docx, args);
          case "get_blocks":
            return await handleGetBlocks(docx, args);
          case "get_block":
            return await handleGetBlock(docx, args);
          case "get_children":
            return await handleGetChildren(docx, args);
          case "create":
            return await handleCreate(docx, args);
          case "create_blocks":
            return await handleCreateBlocks(docx, args);
          case "update_block":
            return await handleUpdateBlock(docx, args);
          default:
            throw toolRecoverableError(`Unknown action: ${(args as { action: string }).action}`, {
              code: "feishu_doc_unknown_action",
            });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "ToolRecoverableError") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw toolRecoverableError(`feishu_doc failed: ${message}`, {
          code: "feishu_doc_error",
        });
      }
    },
  });
}

function requireDocumentId(args: FeishuDocArgs): string {
  if (!args.document_id) {
    throw toolRecoverableError("document_id is required for this action", {
      code: "feishu_doc_missing_document_id",
    });
  }
  return args.document_id;
}

async function handleGetInfo(
  docx: {
    document: {
      get: (p: { path: { document_id: string } }) => Promise<ApiResult<{ document?: unknown }>>;
    };
  },
  args: FeishuDocArgs,
) {
  const result = await docx.document.get({
    path: { document_id: requireDocumentId(args) },
  });
  return jsonToolResult(extractFeishuData(result, "get_info"));
}

async function handleCreate(
  docx: {
    document: {
      create: (payload?: {
        data?: { title?: string; folder_token?: string };
      }) => Promise<ApiResult<{ document?: { document_id?: string; title?: string } }>>;
    };
  },
  args: FeishuDocArgs,
) {
  if (!args.title) {
    throw toolRecoverableError("title is required for create", {
      code: "feishu_doc_missing_title",
    });
  }
  const result = await docx.document.create({
    data: {
      title: args.title,
      ...(args.folder_token ? { folder_token: args.folder_token } : {}),
    },
  });
  return jsonToolResult(extractFeishuData(result, "create"));
}

async function handleGetRawContent(
  docx: {
    document: {
      rawContent: (p: {
        path: { document_id: string };
      }) => Promise<ApiResult<{ content?: string }>>;
    };
  },
  args: FeishuDocArgs,
) {
  const result = await docx.document.rawContent({
    path: { document_id: requireDocumentId(args) },
  });
  const data = extractFeishuData(result, "get_raw_content");
  return textToolResult(data.content ?? "");
}

async function handleGetBlocks(
  docx: {
    documentBlock: {
      list: (p: {
        path: { document_id: string };
        params: Record<string, string>;
      }) => Promise<ApiResult<{ items?: unknown[]; has_more?: boolean; page_token?: string }>>;
    };
  },
  args: FeishuDocArgs,
) {
  const params: Record<string, string> = {
    page_size: String(args.page_size ?? 50),
  };
  if (args.page_token) params.page_token = args.page_token;

  const result = await docx.documentBlock.list({
    path: { document_id: requireDocumentId(args) },
    params,
  });
  return jsonToolResult(extractFeishuData(result, "get_blocks"));
}

async function handleGetBlock(
  docx: {
    documentBlock: {
      get: (p: {
        path: { document_id: string; block_id: string };
      }) => Promise<ApiResult<{ block?: unknown }>>;
    };
  },
  args: FeishuDocArgs,
) {
  if (!args.block_id) {
    throw toolRecoverableError("block_id is required for get_block", {
      code: "feishu_doc_missing_block_id",
    });
  }
  const result = await docx.documentBlock.get({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
  });
  return jsonToolResult(extractFeishuData(result, "get_block"));
}

async function handleGetChildren(
  docx: {
    documentBlock: { children: DocBlockChildrenApi };
  },
  args: FeishuDocArgs,
) {
  if (!args.block_id) {
    throw toolRecoverableError("block_id is required for get_children", {
      code: "feishu_doc_missing_block_id",
    });
  }
  const params: Record<string, string> = {
    page_size: String(args.page_size ?? 50),
  };
  if (args.page_token) params.page_token = args.page_token;

  const result = await docx.documentBlock.children.get({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
    params,
  });
  return jsonToolResult(extractFeishuData(result, "get_children"));
}

async function handleCreateBlocks(
  docx: {
    documentBlock: { children: DocBlockChildrenApi };
  },
  args: FeishuDocArgs,
) {
  if (!args.block_id) {
    throw toolRecoverableError("block_id is required for create_blocks", {
      code: "feishu_doc_missing_block_id",
    });
  }
  if (!args.blocks || args.blocks.length === 0) {
    throw toolRecoverableError("blocks are required for create_blocks", {
      code: "feishu_doc_missing_blocks",
    });
  }

  const children = args.blocks.map((b) => buildBlockPayload(b));

  const result = await docx.documentBlock.children.create({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
    data: { children },
  });
  return jsonToolResult(extractFeishuData(result, "create_blocks"));
}

function buildBlockPayload(block: {
  block_type: string;
  text?: Array<{
    content: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    inline_code?: boolean;
    link?: string;
  }>;
}) {
  const blockType = block.block_type;
  const payload: Record<string, unknown> = {
    block_type: blockTypeToNumber(blockType),
  };

  if (block.text && block.text.length > 0) {
    const elements = block.text.map((t) => {
      const textRun: Record<string, unknown> = { content: t.content };
      const style: Record<string, unknown> = {};
      if (t.bold) style.bold = true;
      if (t.italic) style.italic = true;
      if (t.underline) style.underline = true;
      if (t.strikethrough) style.strikethrough = true;
      if (t.inline_code) style.inline_code = true;
      if (t.link) style.link = { url: t.link };
      if (Object.keys(style).length > 0) {
        textRun.text_element_style = style;
      }
      return { text_run: textRun };
    });

    const blockBody: Record<string, unknown> = { elements };
    const contentKey = blockTypeToContentKey(blockType);
    payload[contentKey] = blockBody;
  }

  return payload;
}

function blockTypeToNumber(type: string): number {
  const map: Record<string, number> = {
    text: 2,
    heading1: 3,
    heading2: 4,
    heading3: 5,
    heading4: 6,
    heading5: 7,
    heading6: 8,
    heading7: 9,
    bullet: 10,
    ordered: 11,
    code: 12,
    quote: 13,
    callout: 14,
    todo: 15,
    divider: 16,
    image: 17,
    table: 18,
  };
  return map[type] ?? 2;
}

function blockTypeToContentKey(type: string): string {
  const map: Record<string, string> = {
    text: "text",
    heading1: "heading1",
    heading2: "heading2",
    heading3: "heading3",
    heading4: "heading4",
    heading5: "heading5",
    heading6: "heading6",
    heading7: "heading7",
    bullet: "bullet",
    ordered: "ordered",
    code: "code",
    quote: "quote",
    todo: "todo",
  };
  return map[type] ?? "text";
}

async function handleUpdateBlock(
  docx: {
    documentBlock: {
      patch: (p: {
        path: { document_id: string; block_id: string };
        data: Record<string, unknown>;
      }) => Promise<ApiResult<{ block?: unknown }>>;
    };
  },
  args: FeishuDocArgs,
) {
  if (!args.block_id) {
    throw toolRecoverableError("block_id is required for update_block", {
      code: "feishu_doc_missing_block_id",
    });
  }
  if (!args.update_text_elements) {
    throw toolRecoverableError("update_text_elements is required for update_block", {
      code: "feishu_doc_missing_update_text_elements",
    });
  }

  const result = await docx.documentBlock.patch({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
    data: {
      update_text_elements: args.update_text_elements as unknown as Record<string, unknown>,
    },
  });
  return jsonToolResult(extractFeishuData(result, "update_block"));
}
