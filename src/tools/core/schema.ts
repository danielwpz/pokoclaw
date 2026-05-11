import type { TSchema } from "@sinclair/typebox";
import {
  parseToolArgs,
  ToolArgumentValidationError,
  type ToolArgumentValidationIssue,
  type ToolDefinition,
} from "@/src/tools/core/types.js";

export type JsonSchemaObject = Record<string, unknown>;

export type ToolInputValidationResult<TArgs = unknown> =
  | {
      ok: true;
      value: TArgs;
    }
  | {
      ok: false;
      message?: string;
      issues?: ToolArgumentValidationIssue[];
      allowedFields?: string[];
    };

export interface TypeBoxToolInputSchema<TArgs = unknown> {
  kind: "typebox";
  schema: TSchema;
  validate?(input: unknown): ToolInputValidationResult<TArgs>;
}

export interface JsonSchemaToolInputSchema<TArgs = unknown> {
  kind: "json_schema";
  schema: JsonSchemaObject;
  validate(input: unknown): ToolInputValidationResult<TArgs>;
}

export type ToolInputSchema<TArgs = unknown> =
  | TypeBoxToolInputSchema<TArgs>
  | JsonSchemaToolInputSchema<TArgs>;

export function typeBoxToolInputSchema<TArgs = unknown>(
  schema: TSchema,
): TypeBoxToolInputSchema<TArgs> {
  return {
    kind: "typebox",
    schema,
  };
}

export function jsonSchemaToolInputSchema<TArgs = unknown>(input: {
  schema: JsonSchemaObject;
  validate(input: unknown): ToolInputValidationResult<TArgs>;
}): JsonSchemaToolInputSchema<TArgs> {
  return {
    kind: "json_schema",
    schema: input.schema,
    validate: input.validate,
  };
}

export function resolveToolInputSchema<TArgs>(
  tool: Pick<ToolDefinition<TArgs>, "inputSchema" | "inputSchemaSpec">,
): ToolInputSchema<TArgs> | null {
  if (tool.inputSchemaSpec != null) {
    return tool.inputSchemaSpec;
  }

  if (tool.inputSchema != null) {
    return typeBoxToolInputSchema<TArgs>(tool.inputSchema);
  }

  return null;
}

export function getModelVisibleToolInputSchema(tool: ToolDefinition): unknown {
  return resolveToolInputSchema(tool)?.schema;
}

export function validateToolInput<TArgs>(
  toolName: string,
  tool: ToolDefinition<TArgs>,
  input: unknown,
): TArgs | unknown {
  const schema = resolveToolInputSchema(tool);
  if (schema == null) {
    return input;
  }

  switch (schema.kind) {
    case "typebox": {
      if (schema.validate != null) {
        return validateWithCustomValidator(toolName, schema.validate(input), schema.schema);
      }
      return parseToolArgs(toolName, schema.schema, input);
    }
    case "json_schema":
      return validateWithCustomValidator(toolName, schema.validate(input), schema.schema);
    default:
      return assertNever(schema);
  }
}

function validateWithCustomValidator<TArgs>(
  toolName: string,
  result: ToolInputValidationResult<TArgs>,
  schema: JsonSchemaObject | TSchema,
): TArgs {
  if (result.ok) {
    return result.value;
  }

  const issues = result.issues ?? [];
  const allowedFields = result.allowedFields ?? extractAllowedFields(schema);
  const message = result.message ?? renderValidationMessage(issues, allowedFields);
  throw new ToolArgumentValidationError(toolName, message, {
    issues,
    allowedFields,
  });
}

function extractAllowedFields(schema: JsonSchemaObject | TSchema): string[] {
  const raw = schema as { properties?: Record<string, unknown> };
  return raw.properties == null ? [] : Object.keys(raw.properties);
}

function renderValidationMessage(
  issues: ToolArgumentValidationIssue[],
  allowedFields: string[],
): string {
  const lines: string[] = [];
  if (issues.length > 0) {
    lines.push("Fix the following argument issues:");
    for (const issue of issues) {
      lines.push(`- ${renderIssuePath(issue.path)}: ${issue.message}.`);
    }
  } else {
    lines.push("Input does not match the declared schema.");
  }

  if (allowedFields.length > 0) {
    lines.push(`Allowed fields: ${allowedFields.join(", ")}.`);
  }

  return lines.join(" ");
}

function renderIssuePath(path: string): string {
  if (path.length === 0 || path === "/") {
    return "(root)";
  }

  return path;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled tool input schema kind: ${JSON.stringify(value)}`);
}
