import type { SecretValueTree } from "@/src/config/schema.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function getSecretPathSegments(ref: string): string[] {
  const prefix = "secret://";

  if (!ref.startsWith(prefix)) {
    throw new Error(`Invalid secret ref: ${ref}`);
  }

  const secretPath = ref.slice(prefix.length);
  if (secretPath.length === 0) {
    throw new Error(`Invalid secret ref: ${ref}`);
  }

  const pathSegments = secretPath.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length === 0) {
    throw new Error(`Invalid secret ref: ${ref}`);
  }

  return pathSegments;
}

export function resolveSecretRef(secrets: SecretValueTree, ref: string): string {
  const pathSegments = getSecretPathSegments(ref);
  let current: string | SecretValueTree = secrets;

  for (const segment of pathSegments) {
    if (typeof current === "string") {
      throw new Error(`Missing secret for ref: ${ref}`);
    }

    if (!hasOwnKey(current, segment)) {
      throw new Error(`Missing secret for ref: ${ref}`);
    }

    const next: string | SecretValueTree | undefined = current[segment];
    if (next == null) {
      throw new Error(`Missing secret for ref: ${ref}`);
    }

    current = next;
  }

  if (typeof current !== "string") {
    throw new Error(`Missing secret for ref: ${ref}`);
  }

  return current;
}

export function resolveConfigRefs<T>(input: T, secrets: SecretValueTree): T {
  if (!isPlainObject(input)) {
    return input;
  }

  const sourceInput: Record<string, unknown> = input;
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sourceInput)) {
    if (key.endsWith("_ref")) {
      if (typeof value !== "string") {
        throw new Error(`Config ref ${key} must be a string`);
      }

      const targetKey = key.slice(0, -4);
      if (targetKey.length === 0) {
        throw new Error(`Config ref key is invalid: ${key}`);
      }
      if (hasOwnKey(sourceInput, targetKey)) {
        throw new Error(`Config cannot contain both ${targetKey} and ${key}`);
      }

      resolved[targetKey] = resolveSecretRef(secrets, value);
      continue;
    }

    resolved[key] = isPlainObject(value) ? resolveConfigRefs(value, secrets) : value;
  }

  return resolved as T;
}
