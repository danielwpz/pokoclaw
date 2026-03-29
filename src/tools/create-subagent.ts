import { type Static, Type } from "@sinclair/typebox";
import { type PermissionScope, parsePermissionScope } from "@/src/security/scope.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { toolInternalError, toolRecoverableError } from "@/src/tools/core/errors.js";
import { defineTool, textToolResult } from "@/src/tools/core/types.js";

const INITIAL_EXTRA_SCOPE_SCHEMA = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Union([Type.Literal("fs.read"), Type.Literal("fs.write")]),
        path: Type.String({ minLength: 1 }),
      },
      {
        additionalProperties: false,
        description:
          'Filesystem scope. Exact shape: {"kind":"fs.read"|"fs.write","path":"/abs/path"}',
      },
    ),
    Type.Object(
      {
        kind: Type.Union([Type.Literal("db.read"), Type.Literal("db.write")]),
        database: Type.Literal("system"),
      },
      {
        additionalProperties: false,
        description:
          'System DB scope. Exact shape: {"kind":"db.read"|"db.write","database":"system"}',
      },
    ),
    Type.Object(
      {
        kind: Type.Literal("bash.full_access"),
        prefix: Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
        }),
      },
      {
        additionalProperties: false,
        description:
          'Reusable bash full-access prefix. Exact shape: {"kind":"bash.full_access","prefix":["git","status"]}',
      },
    ),
  ],
  {
    description:
      "Optional extra pre-authorized scopes for the created SubAgent. Omit this field unless it is truly needed.",
  },
);

export const CREATE_SUBAGENT_TOOL_SCHEMA = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      description:
        'The SubAgent display name and future conversation title, for example "Pokeclaw Code Review".',
    }),
    description: Type.String({
      minLength: 1,
      description: "The durable role and responsibility of the SubAgent, not just the first task.",
    }),
    initialTask: Type.String({
      minLength: 1,
      description:
        "The concrete kickoff task for the newly created SubAgent. This becomes the first hidden kickoff message, not part of the system prompt.",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional absolute working directory for the SubAgent. If omitted, it defaults to the SubAgent's dedicated workspace inside the Pokeclaw workspace.",
      }),
    ),
    initialExtraScopes: Type.Optional(
      Type.Array(INITIAL_EXTRA_SCOPE_SCHEMA, {
        maxItems: 16,
        description:
          "Optional array of exact scope objects. Prefer omitting this field entirely unless pre-authorized access is required.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type CreateSubagentToolArgs = Static<typeof CREATE_SUBAGENT_TOOL_SCHEMA>;

export function createCreateSubagentTool() {
  return defineTool({
    name: "create_subagent",
    description:
      "Submit a pending request to create a long-lived SubAgent in its own dedicated conversation when the task is complex enough to deserve a separate context. Prefer the minimal call shape: title, description, initialTask, and optional cwd. Only include initialExtraScopes when the SubAgent truly needs pre-authorized access, and every scope entry must exactly match one allowed object shape.",
    inputSchema: CREATE_SUBAGENT_TOOL_SCHEMA,
    async execute(context, args) {
      const sessionsRepo = new SessionsRepo(context.storage);
      const agentsRepo = new AgentsRepo(context.storage);
      const session = sessionsRepo.getById(context.sessionId);

      if (session == null) {
        throw toolInternalError(`Source session not found: ${context.sessionId}`);
      }
      if (session.purpose !== "chat") {
        throw toolRecoverableError(
          "create_subagent is only available in the main-agent chat session.",
          {
            code: "create_subagent_wrong_session_purpose",
            sessionId: context.sessionId,
            sessionPurpose: session.purpose,
          },
        );
      }
      if (session.ownerAgentId == null) {
        throw toolRecoverableError(
          "create_subagent requires a source session owned by the main agent.",
          {
            code: "create_subagent_missing_owner",
            sessionId: context.sessionId,
          },
        );
      }

      const ownerAgent = agentsRepo.getById(session.ownerAgentId);
      if (ownerAgent == null || ownerAgent.kind !== "main") {
        throw toolRecoverableError("create_subagent is only available to the main agent.", {
          code: "create_subagent_not_main_agent",
          ownerAgentId: session.ownerAgentId,
        });
      }

      if (context.runtimeControl?.requestSubagentCreation == null) {
        throw toolInternalError(
          "create_subagent is missing the host runtime control needed to submit the SubAgent creation request.",
        );
      }

      const initialExtraScopes = normalizeInitialExtraScopes(args.initialExtraScopes);
      const submitted = await context.runtimeControl.requestSubagentCreation({
        sourceSessionId: context.sessionId,
        title: args.title,
        description: args.description,
        initialTask: args.initialTask,
        ...(args.cwd == null ? {} : { cwd: args.cwd }),
        ...(initialExtraScopes.length === 0 ? {} : { initialExtraScopes }),
      });

      return textToolResult(
        [
          `Submitted a pending SubAgent creation request for "${submitted.title}".`,
          `Request id: ${submitted.requestId}`,
          `Workdir: ${submitted.workdir}`,
          `Private workspace: ${submitted.privateWorkspaceDir}`,
          "This request now needs user confirmation before the SubAgent will actually be created.",
        ].join("\n"),
        submitted,
      );
    },
  });
}

function normalizeInitialExtraScopes(
  scopes: CreateSubagentToolArgs["initialExtraScopes"],
): PermissionScope[] {
  return (scopes ?? []).map((scope) => parsePermissionScope(scope));
}
