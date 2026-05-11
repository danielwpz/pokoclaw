import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import {
  type JsonSchemaObject,
  type JsonSchemaToolInputSchema,
  jsonSchemaToolInputSchema,
  type ToolInputValidationResult,
} from "@/src/tools/core/schema.js";

const validatorProvider = new AjvJsonSchemaValidator();

export function ajvJsonSchemaToolInputSchema<TArgs = unknown>(
  schema: JsonSchemaObject,
): JsonSchemaToolInputSchema<TArgs> {
  const validate = validatorProvider.getValidator<TArgs>(schema as JsonSchemaType);
  return jsonSchemaToolInputSchema<TArgs>({
    schema,
    validate(input: unknown): ToolInputValidationResult<TArgs> {
      const result = validate(input);
      if (result.valid) {
        return {
          ok: true,
          value: result.data,
        };
      }

      return {
        ok: false,
        message: result.errorMessage,
      };
    },
  });
}
