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
        Type.Literal("convert_markdown"),
        Type.Literal("delete_blocks"),
        Type.Literal("append"),
        Type.Literal("batch_update"),
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
    index: Type.Optional(
      Type.Number({
        description:
          "Insert position for create_blocks. -1 = end (default). 0 = beginning. N = after Nth child.",
      }),
    ),
    content: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Markdown or HTML content for convert_markdown action.",
      }),
    ),
    content_type: Type.Optional(
      Type.String({
        description: "Content type for convert_markdown: 'markdown' (default) or 'html'.",
      }),
    ),
    start_index: Type.Optional(
      Type.Number({
        minimum: 0,
        description: "Start index (inclusive) for delete_blocks. 0 = first child.",
      }),
    ),
    end_index: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "End index (exclusive) for delete_blocks. Deletes children [start_index, end_index).",
      }),
    ),
    requests: Type.Optional(
      Type.Array(
        Type.Object(
          {
            block_id: Type.String({
              minLength: 1,
              description: "Block ID to update.",
            }),
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
                                  bold: Type.Optional(Type.Boolean()),
                                  italic: Type.Optional(Type.Boolean()),
                                  underline: Type.Optional(Type.Boolean()),
                                  strikethrough: Type.Optional(Type.Boolean()),
                                  inline_code: Type.Optional(Type.Boolean()),
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
    permission_members: Type.Optional(
      Type.Array(
        Type.Object(
          {
            member_type: Type.String({
              description:
                "Member type for permission: 'openid', 'unionid', 'email'. Required with member_id.",
            }),
            member_id: Type.String({
              minLength: 1,
              description: "Member ID matching the member_type (e.g. openid like 'ou_xxx').",
            }),
            perm: Type.Optional(
              Type.String({
                description:
                  "Permission level: 'full_access' (可管理), 'edit' (可编辑), 'view' (可阅读/默认), 'comment' (可评论).",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        {
          description:
            "Collaborators to add to the document after creation. Each entry grants permission to one member. Requires drive:drive + docs:permission.member:create scopes.",
        },
      ),
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
  batchDelete: (payload: {
    path: { document_id: string; block_id: string };
    data: { start_index: number; end_index: number };
  }) => Promise<ApiResult<{ document_revision_id?: number }>>;
};

type DocBlockDescendantApi = {
  create: (payload: {
    path: { document_id: string; block_id: string };
    data: { children_id: string[]; descendants: unknown[]; index?: number };
  }) => Promise<ApiResult<{ descendants?: unknown[] }>>;
};

export function createFeishuDocTool(input: {
  installationId: string;
  clientSource: FeishuClientSource;
  collaboratorOpenId?: string;
}) {
  const client = input.clientSource.getClient(input.installationId);
  const collaboratorOpenId = input.collaboratorOpenId;

  return defineTool({
    name: "feishu_doc",
    description:
      "Read and write Feishu/Lark documents (Docx). " +
      "Actions: get_info, get_raw_content, get_blocks, get_block, get_children, " +
      "create, create_blocks, update_block, batch_update (batch update multiple blocks), " +
      "convert_markdown (convert markdown to blocks), delete_blocks (batch delete children by index range), " +
      "append (shorthand for create_blocks at document end). " +
      "Block types: text, heading1-9, bullet, ordered, code, quote, todo, divider, image, table.",
    inputSchema: FEISHU_DOC_SCHEMA,
    getInvocationTimeoutMs() {
      return 30_000;
    },
    async execute(_context, args) {
      logger.info("executing feishu_doc", {
        action: args.action,
        documentId: args.document_id,
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
            convert: (payload?: {
              data: { content: string; content_type?: string };
            }) => Promise<ApiResult<{ blocks?: unknown[]; first_level_block_ids?: string[] }>>;
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
            batchUpdate: (payload: {
              path: { document_id: string };
              data: { requests: Array<{ block_id: string; [key: string]: unknown }> };
            }) => Promise<ApiResult<{ blocks?: unknown[] }>>;
          };
          documentBlockChildren: DocBlockChildrenApi;
          documentBlockDescendant: DocBlockDescendantApi;
        };

        const driveApi = client.drive as unknown as {
          permissionMember: {
            create: (payload: {
              path: { token: string };
              params: { type: string };
              data: { member_type: string; member_id: string; perm?: string };
            }) => Promise<ApiResult<unknown>>;
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
            return await handleCreate(docx, driveApi, args, collaboratorOpenId);
          case "create_blocks":
            return await handleCreateBlocks(docx, args);
          case "update_block":
            return await handleUpdateBlock(docx, args);
          case "convert_markdown":
            return await handleConvertMarkdown(docx, args);
          case "delete_blocks":
            return await handleDeleteBlocks(docx, args);
          case "append":
            return await handleAppend(docx, args);
          case "batch_update":
            return await handleBatchUpdate(docx, args);
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

        throw toolRecoverableError(`feishu_doc failed: ${message}${detail}`, {
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
  driveApi: {
    permissionMember: {
      create: (payload: {
        path: { token: string };
        params: { type: string };
        data: { member_type: string; member_id: string; perm?: string };
      }) => Promise<ApiResult<unknown>>;
    };
  },
  args: FeishuDocArgs,
  collaboratorOpenId?: string,
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
  const docData = extractFeishuData(result, "create");
  const documentId = (docData as { document?: { document_id?: string } }).document?.document_id;

  // Merge collaboratorOpenId config with explicit permission_members
  const members: Array<{ member_type: string; member_id: string; perm: string }> = [];
  if (collaboratorOpenId) {
    members.push({ member_type: "openid", member_id: collaboratorOpenId, perm: "full_access" });
  }
  if (args.permission_members) {
    for (const m of args.permission_members) {
      members.push({ member_type: m.member_type, member_id: m.member_id, perm: m.perm ?? "view" });
    }
  }

  // Add collaborators if any
  if (members.length > 0 && documentId) {
    const permResults: Array<{
      member_type: string;
      member_id: string;
      success: boolean;
      error?: string;
    }> = [];
    for (const member of members) {
      try {
        await driveApi.permissionMember.create({
          path: { token: documentId },
          params: { type: "docx" },
          data: {
            member_type: member.member_type,
            member_id: member.member_id,
            perm: member.perm,
          },
        });
        permResults.push({
          member_type: member.member_type,
          member_id: member.member_id,
          success: true,
        });
      } catch (permError) {
        const msg = permError instanceof Error ? permError.message : String(permError);
        logger.warn("failed to add permission member", {
          documentId,
          member_type: member.member_type,
          error: msg,
        });
        permResults.push({
          member_type: member.member_type,
          member_id: member.member_id,
          success: false,
          error: msg,
        });
      }
    }
    return jsonToolResult({ document: docData, permissions: permResults });
  }

  return jsonToolResult(docData);
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
    documentBlockChildren: DocBlockChildrenApi;
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

  const result = await docx.documentBlockChildren.get({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
    params,
  });
  return jsonToolResult(extractFeishuData(result, "get_children"));
}

async function handleCreateBlocks(
  docx: {
    documentBlockChildren: DocBlockChildrenApi;
    documentBlockDescendant: DocBlockDescendantApi;
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

  const timestamp = Date.now();
  const descendants = args.blocks.map((b, i) => {
    const tempId = `tmp_${timestamp}_${i}`;
    const payload = buildBlockPayload(b);
    return { block_id: tempId, ...payload };
  });
  const childrenIds = descendants.map((d) => d.block_id);

  const result = await docx.documentBlockDescendant.create({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
    data: { children_id: childrenIds, descendants, index: args.index ?? -1 },
  });

  // Extract descendants from result for consistent response format
  const data = extractFeishuData(result, "create_blocks");
  // Map descendants to children for backward compatibility
  const mapped = data as Record<string, unknown>;
  if (mapped.descendants && !mapped.children) {
    mapped.children = mapped.descendants;
    delete mapped.descendants;
  }
  return jsonToolResult(mapped);
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
      } else {
        // Descendant API may require text_element_style for structured blocks
        textRun.text_element_style = {};
      }
      return { text_run: textRun };
    });

    const blockBody: Record<string, unknown> = { elements, style: {} };
    const contentKey = blockTypeToContentKey(blockType);
    payload[contentKey] = blockBody;
  } else {
    // Blocks without text (divider, image placeholder) still need their content key
    const contentKey = blockTypeToContentKey(blockType);
    payload[contentKey] = {};
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
    heading8: 10,
    heading9: 11,
    bullet: 12,
    ordered: 13,
    code: 14,
    quote: 15,
    callout: 19,
    todo: 17,
    divider: 22,
    image: 27,
    table: 31,
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
    heading8: "heading8",
    heading9: "heading9",
    bullet: "bullet",
    ordered: "ordered",
    code: "code",
    quote: "quote",
    todo: "todo",
    divider: "divider",
    image: "image",
    table: "table",
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

async function handleConvertMarkdown(
  docx: {
    document: {
      convert: (payload: {
        data: { content: string; content_type?: string };
      }) => Promise<ApiResult<{ blocks?: unknown[]; first_level_block_ids?: string[] }>>;
    };
  },
  args: FeishuDocArgs,
) {
  if (!args.content) {
    throw toolRecoverableError("content is required for convert_markdown", {
      code: "feishu_doc_missing_content",
    });
  }

  const result = await docx.document.convert({
    data: { content: args.content, content_type: args.content_type ?? "markdown" },
  });
  return jsonToolResult(extractFeishuData(result, "convert_markdown"));
}

async function handleDeleteBlocks(
  docx: {
    documentBlockChildren: DocBlockChildrenApi;
  },
  args: FeishuDocArgs,
) {
  if (!args.block_id) {
    throw toolRecoverableError("block_id is required for delete_blocks", {
      code: "feishu_doc_missing_block_id",
    });
  }
  if (args.start_index === undefined || args.start_index === null) {
    throw toolRecoverableError("start_index is required for delete_blocks", {
      code: "feishu_doc_missing_start_index",
    });
  }
  if (args.end_index === undefined || args.end_index === null) {
    throw toolRecoverableError("end_index is required for delete_blocks", {
      code: "feishu_doc_missing_end_index",
    });
  }

  const result = await docx.documentBlockChildren.batchDelete({
    path: { document_id: requireDocumentId(args), block_id: args.block_id },
    data: { start_index: args.start_index, end_index: args.end_index },
  });
  return jsonToolResult(extractFeishuData(result, "delete_blocks"));
}

async function handleAppend(
  docx: {
    documentBlockChildren: DocBlockChildrenApi;
    documentBlockDescendant: DocBlockDescendantApi;
  },
  args: FeishuDocArgs,
) {
  // Append is create_blocks at document root with index=-1
  const augmentedArgs = {
    ...args,
    block_id: (args.block_id ?? args.document_id) as string,
    index: args.index ?? -1,
  };
  return await handleCreateBlocks(docx, augmentedArgs);
}

async function handleBatchUpdate(
  docx: {
    documentBlock: {
      batchUpdate: (payload: {
        path: { document_id: string };
        data: { requests: Array<{ block_id: string; [key: string]: unknown }> };
      }) => Promise<ApiResult<{ blocks?: unknown[] }>>;
    };
  },
  args: FeishuDocArgs,
) {
  if (!args.requests || args.requests.length === 0) {
    throw toolRecoverableError("requests is required for batch_update", {
      code: "feishu_doc_missing_requests",
    });
  }

  const requests = args.requests.map((r) => {
    const req: Record<string, unknown> = { block_id: r.block_id };
    if (r.update_text_elements) {
      req.update_text_elements = r.update_text_elements as unknown as Record<string, unknown>;
    }
    return req as { block_id: string; [key: string]: unknown };
  });

  const result = await docx.documentBlock.batchUpdate({
    path: { document_id: requireDocumentId(args) },
    data: { requests },
  });
  return jsonToolResult(extractFeishuData(result, "batch_update"));
}
