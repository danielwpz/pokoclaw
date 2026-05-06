import { getJsonPointer, isRecord, resolveBoundValue, setJsonPointer } from "./json.js";
import { readComponentRef } from "./surface.js";
import { CALLBACK_ENVELOPE_VERSION } from "./types.js";
export function extractLarkCallback(rawPayload) {
  const root = readRecord(rawPayload, "Lark callback payload");
  const event = readLarkCallbackEvent(root);
  const action = readRecord(event.action, "Lark callback event.action");
  const envelope = readCallbackEnvelope(action.value);
  const submittedValues = readSubmittedValues(action);
  const timestamp = readCallbackTimestamp(root);
  const input = {
    envelope,
  };
  if (submittedValues != null) {
    input.submittedValues = submittedValues;
  }
  if (timestamp != null) {
    input.timestamp = timestamp;
  }
  if (isRecord(event.operator)) {
    input.operator = event.operator;
  }
  return input;
}
export function normalizeCallback(surface, input) {
  validateEnvelope(surface, input.envelope);
  applySubmittedValues(surface, input.submittedValues ?? {});
  const source = readComponentRef(surface, input.envelope.sourceComponentId);
  if (source.type !== "Button") {
    throw new Error(`Callback source '${source.id}' is not a Button`);
  }
  const action = readButtonAction(source.props.action);
  const actionName = input.envelope.actionName ?? action.name;
  if (actionName !== action.name) {
    throw new Error(
      `Callback action '${actionName}' does not match Button action '${action.name}'`,
    );
  }
  return {
    userAction: {
      name: action.name,
      surfaceId: surface.surfaceId,
      sourceComponentId: source.id,
      timestamp: input.timestamp ?? new Date().toISOString(),
      context: resolveActionContext(action.context ?? [], surface.dataModel),
    },
  };
}
function readLarkCallbackEvent(root) {
  if (isRecord(root.event) && isRecord(root.event.action)) {
    return root.event;
  }
  if (isRecord(root.action)) {
    return root;
  }
  throw new Error("Lark callback payload does not contain event.action");
}
function readCallbackEnvelope(value) {
  const envelopeValue = parseCallbackValue(value);
  if (
    !isRecord(envelopeValue) ||
    envelopeValue.__a2ui_lark !== CALLBACK_ENVELOPE_VERSION ||
    typeof envelopeValue.surfaceId !== "string" ||
    typeof envelopeValue.sourceComponentId !== "string"
  ) {
    throw new Error("Lark callback action.value does not contain an A2UI callback envelope");
  }
  const envelope = {
    __a2ui_lark: CALLBACK_ENVELOPE_VERSION,
    surfaceId: envelopeValue.surfaceId,
    sourceComponentId: envelopeValue.sourceComponentId,
  };
  if (typeof envelopeValue.actionName === "string") {
    envelope.actionName = envelopeValue.actionName;
  }
  if (typeof envelopeValue.actionId === "string") {
    envelope.actionId = envelopeValue.actionId;
  }
  return envelope;
}
function parseCallbackValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function readSubmittedValues(action) {
  if (isRecord(action.form_value)) {
    return action.form_value;
  }
  const name = typeof action.name === "string" && action.name.length > 0 ? action.name : null;
  if (name == null) {
    return undefined;
  }
  if ("input_value" in action) {
    return { [name]: action.input_value };
  }
  if ("option" in action) {
    return { [name]: action.option };
  }
  if ("options" in action) {
    return { [name]: action.options };
  }
  if ("checked" in action) {
    return { [name]: action.checked };
  }
  return undefined;
}
function readCallbackTimestamp(root) {
  const header = isRecord(root.header) ? root.header : undefined;
  const createTime = header?.create_time ?? root.create_time;
  if (typeof createTime !== "string" || createTime.length === 0) {
    return undefined;
  }
  if (/^\d+$/.test(createTime)) {
    const milliseconds = Number(BigInt(createTime) / 1000n);
    if (Number.isFinite(milliseconds)) {
      return new Date(milliseconds).toISOString();
    }
  }
  const parsed = Date.parse(createTime);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function readRecord(value, field) {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}
function validateEnvelope(surface, envelope) {
  if (envelope.__a2ui_lark !== CALLBACK_ENVELOPE_VERSION) {
    throw new Error(`Unsupported callback envelope version '${envelope.__a2ui_lark}'`);
  }
  if (envelope.surfaceId !== surface.surfaceId) {
    throw new Error(
      `Callback surface '${envelope.surfaceId}' does not match '${surface.surfaceId}'`,
    );
  }
  if (envelope.actionName == null && envelope.actionId == null) {
    throw new Error("Callback envelope must contain actionName or actionId");
  }
}
function applySubmittedValues(surface, submittedValues) {
  if (Object.keys(submittedValues).length === 0) {
    return;
  }
  for (const component of surface.components.values()) {
    const ref = readComponentRef(surface, component.id);
    if (ref.type !== "TextField" && ref.type !== "MultipleChoice" && ref.type !== "DateTimeInput") {
      continue;
    }
    const name = typeof ref.props.name === "string" ? ref.props.name : null;
    if (name == null || !(name in submittedValues)) {
      continue;
    }
    const path = readBoundPath(ref);
    if (path == null) {
      continue;
    }
    surface.dataModel = setJsonPointer(
      surface.dataModel,
      path,
      coerceSubmittedValue(ref.type, ref.props, submittedValues[name]),
    );
  }
}
function readBoundPath(ref) {
  const binding =
    ref.type === "TextField"
      ? ref.props.text
      : ref.type === "MultipleChoice"
        ? ref.props.selections
        : ref.props.value;
  if (!isRecord(binding) || typeof binding.path !== "string") {
    return null;
  }
  return binding.path;
}
function coerceSubmittedValue(type, props, value) {
  if (type === "MultipleChoice") {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry));
    }
    if (value == null) {
      return [];
    }
    return [String(value)];
  }
  if (type === "TextField" && props.textFieldType === "number") {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
  }
  return value;
}
function resolveActionContext(context, dataModel) {
  const resolved = {};
  for (const entry of context) {
    const value =
      isRecord(entry.value) && typeof entry.value.path === "string"
        ? getJsonPointer(dataModel, entry.value.path)
        : resolveBoundValue(entry.value, dataModel);
    resolved[entry.key] = value;
  }
  return resolved;
}
function readButtonAction(value) {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("Button.action.name is required");
  }
  const action = {
    name: value.name,
  };
  if (Array.isArray(value.context)) {
    action.context = value.context;
  }
  return action;
}
