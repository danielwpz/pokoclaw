import type { SecretValueTree } from "@/src/config/schema.js";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ConfigRefSources {
  secrets: SecretValueTree;
  env?: NodeJS.ProcessEnv;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function getRefPayload(ref: string, prefix: string, errorKind: string): string {
  if (!ref.startsWith(prefix)) {
    throw new Error(`Invalid ${errorKind} ref: ${ref}`);
  }

  const payload = ref.slice(prefix.length);
  if (payload.length === 0) {
    throw new Error(`Invalid ${errorKind} ref: ${ref}`);
  }

  return payload;
}

function getSecretPathSegments(ref: string): string[] {
  const secretPath = getRefPayload(ref, "secret://", "secret");
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

function getEnvVarName(ref: string): string {
  const envVarName = getRefPayload(ref, "env://", "env");
  if (!ENV_VAR_NAME_RE.test(envVarName)) {
    throw new Error(`Invalid env ref: ${ref}`);
  }

  return envVarName;
}

export function resolveEnvRef(env: NodeJS.ProcessEnv, ref: string): string {
  const envVarName = getEnvVarName(ref);
  const value = env[envVarName];
  if (value == null) {
    throw new Error(`Missing env for ref: ${ref}`);
  }

  return value;
}

function resolveRefValue(ref: string, sources: ConfigRefSources): string {
  if (ref.startsWith("secret://")) {
    return resolveSecretRef(sources.secrets, ref);
  }
  if (ref.startsWith("env://")) {
    return resolveEnvRef(sources.env ?? process.env, ref);
  }

  throw new Error(`Invalid config ref: ${ref}`);
}

export function resolveConfigRefs<T>(input: T, sources: ConfigRefSources): T {
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

      resolved[targetKey] = resolveRefValue(value, sources);
      continue;
    }

    resolved[key] = isPlainObject(value) ? resolveConfigRefs(value, sources) : value;
  }

  return resolved as T;
}
