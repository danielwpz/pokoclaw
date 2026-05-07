import { isRecord } from "./json.js";
import { renderSurface } from "./render.js";
import { readComponentRef, SurfaceStore } from "./surface.js";
import { LARK_CARD_CATALOG_ID, LARK_CARD_LIVE_CATALOG_ID } from "./types.js";
export const LARK_CARD_COMPONENT_TYPES = [
  "Text",
  "Column",
  "Row",
  "Divider",
  "Button",
  "Form",
  "TextField",
  "MultipleChoice",
  "DateTimeInput",
];
const LARK_EXTENSION_COMPONENT_TYPES = ["Grid"];
const RENDERABLE_COMPONENT_TYPE_SET = new Set([
  ...LARK_CARD_COMPONENT_TYPES,
  ...LARK_EXTENSION_COMPONENT_TYPES,
]);
const CORE_MESSAGE_KEYS = ["surfaceUpdate", "dataModelUpdate", "beginRendering", "deleteSurface"];
export function validateA2uiMessages(input, options = {}) {
  const requireBeginRendering = options.requireBeginRendering ?? true;
  const requireCatalogId = options.requireCatalogId ?? true;
  const treatRenderWarningsAsErrors = options.treatRenderWarningsAsErrors ?? true;
  const issues = [];
  if (!Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          severity: "error",
          message: "A2UI output must be a JSON array of v0.8 server messages",
        },
      ],
      renderedSurfaceIds: [],
    };
  }
  const beginSurfaceIds = new Set();
  const componentIdsBySurface = new Map();
  for (const [index, message] of input.entries()) {
    validateMessage(message, index, issues, beginSurfaceIds, componentIdsBySurface, {
      requireCatalogId,
    });
  }
  if (requireBeginRendering && beginSurfaceIds.size === 0) {
    addError(issues, "$", "At least one beginRendering message is required");
  }
  const renderedSurfaceIds = [];
  if (!hasErrors(issues)) {
    try {
      const store = new SurfaceStore();
      store.applyMessages(input);
      for (const surfaceId of beginSurfaceIds) {
        const surface = store.getSurface(surfaceId);
        validateRenderedSurface(surface, issues);
        const rendered = renderSurface(surface);
        renderedSurfaceIds.push(rendered.surfaceId);
        for (const warning of rendered.warnings) {
          issues.push({
            path: warning.componentId == null ? "$" : `$.component(${warning.componentId})`,
            severity: treatRenderWarningsAsErrors ? "error" : "warning",
            message: warning.message,
          });
        }
      }
    } catch (error) {
      addError(issues, "$", error instanceof Error ? error.message : String(error));
    }
  }
  return {
    ok: !hasErrors(issues),
    issues,
    renderedSurfaceIds,
  };
}
export function assertValidA2uiMessages(input, options = {}) {
  const result = validateA2uiMessages(input, options);
  if (!result.ok) {
    throw new Error(formatValidationIssues(result.issues));
  }
}
export function formatValidationIssues(issues) {
  return issues
    .map((issue) => `${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`)
    .join("\n");
}
function validateMessage(message, index, issues, beginSurfaceIds, componentIdsBySurface, options) {
  const path = `$[${index}]`;
  if (!isRecord(message)) {
    addError(issues, path, "Message must be an object");
    return;
  }
  const presentKeys = CORE_MESSAGE_KEYS.filter((key) => key in message);
  if (presentKeys.length !== 1) {
    addError(issues, path, "Message must contain exactly one A2UI v0.8 message key");
    return;
  }
  const key = presentKeys[0];
  if (key === "surfaceUpdate") {
    validateSurfaceUpdate(
      message.surfaceUpdate,
      `${path}.surfaceUpdate`,
      issues,
      componentIdsBySurface,
    );
    return;
  }
  if (key === "dataModelUpdate") {
    validateDataModelUpdate(message.dataModelUpdate, `${path}.dataModelUpdate`, issues);
    return;
  }
  if (key === "beginRendering") {
    validateBeginRendering(
      message.beginRendering,
      `${path}.beginRendering`,
      issues,
      beginSurfaceIds,
      options,
    );
    return;
  }
  validateDeleteSurface(message.deleteSurface, `${path}.deleteSurface`, issues);
}
function validateSurfaceUpdate(value, path, issues, componentIdsBySurface) {
  if (!isRecord(value)) {
    addError(issues, path, "surfaceUpdate must be an object");
    return;
  }
  const surfaceId = readString(value.surfaceId);
  if (surfaceId == null) {
    addError(issues, `${path}.surfaceId`, "surfaceId is required");
  }
  if (!Array.isArray(value.components)) {
    addError(issues, `${path}.components`, "components must be an array");
    return;
  }
  const seenIds =
    surfaceId == null ? new Set() : ensureComponentSet(componentIdsBySurface, surfaceId);
  for (const [index, component] of value.components.entries()) {
    validateComponentNode(component, `${path}.components[${index}]`, issues, seenIds);
  }
}
function validateDataModelUpdate(value, path, issues) {
  if (!isRecord(value)) {
    addError(issues, path, "dataModelUpdate must be an object");
    return;
  }
  if (readString(value.surfaceId) == null) {
    addError(issues, `${path}.surfaceId`, "surfaceId is required");
  }
  if (value.path !== undefined && readString(value.path) == null) {
    addError(issues, `${path}.path`, "path must be a JSON pointer string when provided");
  }
  if (!Array.isArray(value.contents)) {
    addError(issues, `${path}.contents`, "contents must be an array");
    return;
  }
  value.contents.forEach((entry, index) => {
    validateDataEntry(entry, `${path}.contents[${index}]`, issues);
  });
}
function validateBeginRendering(value, path, issues, beginSurfaceIds, options) {
  if (!isRecord(value)) {
    addError(issues, path, "beginRendering must be an object");
    return;
  }
  const surfaceId = readString(value.surfaceId);
  if (surfaceId == null) {
    addError(issues, `${path}.surfaceId`, "surfaceId is required");
  } else {
    beginSurfaceIds.add(surfaceId);
  }
  if (readString(value.root) == null) {
    addError(issues, `${path}.root`, "root component id is required");
  }
  if (options.requireCatalogId && readString(value.catalogId) == null) {
    addError(issues, `${path}.catalogId`, "catalogId is required for Lark card generation");
  }
  if (
    value.catalogId !== undefined &&
    value.catalogId !== LARK_CARD_CATALOG_ID &&
    value.catalogId !== LARK_CARD_LIVE_CATALOG_ID
  ) {
    addError(
      issues,
      `${path}.catalogId`,
      `catalogId must be '${LARK_CARD_CATALOG_ID}' or '${LARK_CARD_LIVE_CATALOG_ID}' for this renderer`,
    );
  }
}
function validateDeleteSurface(value, path, issues) {
  if (!isRecord(value)) {
    addError(issues, path, "deleteSurface must be an object");
    return;
  }
  if (readString(value.surfaceId) == null) {
    addError(issues, `${path}.surfaceId`, "surfaceId is required");
  }
}
function validateComponentNode(value, path, issues, seenIds) {
  if (!isRecord(value)) {
    addError(issues, path, "Component node must be an object");
    return;
  }
  const id = readString(value.id);
  if (id == null) {
    addError(issues, `${path}.id`, "Component id is required");
  } else if (seenIds.has(id)) {
    addError(issues, `${path}.id`, `Duplicate component id '${id}'`);
  } else {
    seenIds.add(id);
  }
  if (!isRecord(value.component)) {
    addError(issues, `${path}.component`, "component must be an object with one component type");
    return;
  }
  const entries = Object.entries(value.component);
  if (entries.length !== 1) {
    addError(issues, `${path}.component`, "component must contain exactly one component type");
    return;
  }
  const [type, props] = entries[0];
  if (!RENDERABLE_COMPONENT_TYPE_SET.has(type)) {
    addError(issues, `${path}.component.${type}`, `Unsupported component type '${type}'`);
    return;
  }
  if (!isRecord(props)) {
    addError(issues, `${path}.component.${type}`, "Component properties must be an object");
    return;
  }
  validateComponentProps(type, props, `${path}.component.${type}`, issues);
}
function validateComponentProps(type, props, path, issues) {
  switch (type) {
    case "Text":
      validateBoundString(props.text, `${path}.text`, issues);
      return;
    case "Column":
    case "Row":
      validateChildren(props.children, `${path}.children`, issues);
      return;
    case "Divider":
      return;
    case "Button":
      if (readString(props.child) == null) {
        addError(issues, `${path}.child`, "Button.child must reference a Text component id");
      }
      validateAction(props.action, `${path}.action`, issues);
      return;
    case "Form":
      validateChildren(props.children, `${path}.children`, issues);
      if (readString(props.submit) == null) {
        addError(issues, `${path}.submit`, "Form.submit must reference a Button component id");
      }
      return;
    case "TextField":
      if (readString(props.name) == null) {
        addError(issues, `${path}.name`, "TextField.name is required");
      }
      validateBoundString(props.label, `${path}.label`, issues);
      if (props.text !== undefined) {
        validateBoundString(props.text, `${path}.text`, issues);
      }
      return;
    case "MultipleChoice":
      if (readString(props.name) == null) {
        addError(issues, `${path}.name`, "MultipleChoice.name is required");
      }
      validateBoundString(props.label, `${path}.label`, issues);
      if (!isRecord(props.selections)) {
        addError(issues, `${path}.selections`, "MultipleChoice.selections is required");
      }
      if (!Array.isArray(props.options) || props.options.length === 0) {
        addError(issues, `${path}.options`, "MultipleChoice.options must be a non-empty array");
      }
      return;
    case "DateTimeInput":
      if (readString(props.name) == null) {
        addError(issues, `${path}.name`, "DateTimeInput.name is required");
      }
      validateBoundString(props.value, `${path}.value`, issues);
      return;
    case "Grid":
      validateGridProps(props, path, issues);
      return;
  }
}
function validateRenderedSurface(surface, issues) {
  const inputNames = new Set();
  for (const node of surface.components.values()) {
    const component = readComponentRef(surface, node.id);
    if (component.type === "Column" || component.type === "Row") {
      validateChildReferences(surface, component.props.children, node.id, issues);
    }
    if (component.type === "Grid") {
      validateChildReferences(surface, component.props.children, node.id, issues);
    }
    if (component.type === "Grid" && surface.catalogId !== LARK_CARD_LIVE_CATALOG_ID) {
      addError(
        issues,
        `$.surface(${surface.surfaceId}).component(${node.id})`,
        `Grid requires catalogId '${LARK_CARD_LIVE_CATALOG_ID}'`,
      );
    }
    if (component.type === "Form") {
      validateChildReferences(surface, component.props.children, node.id, issues);
      const submitId = readString(component.props.submit);
      if (submitId != null) {
        assertReferencedType(surface, submitId, "Button", node.id, "Form.submit", issues);
      }
    }
    if (component.type === "Button") {
      const childId = readString(component.props.child);
      if (childId != null) {
        assertReferencedType(surface, childId, "Text", node.id, "Button.child", issues);
      }
    }
    if (
      component.type === "TextField" ||
      component.type === "MultipleChoice" ||
      component.type === "DateTimeInput"
    ) {
      const name = readString(component.props.name);
      if (name == null) {
        continue;
      }
      if (inputNames.has(name)) {
        addError(
          issues,
          `$.surface(${surface.surfaceId}).component(${node.id}).name`,
          `Duplicate form field name '${name}'`,
        );
      }
      inputNames.add(name);
    }
  }
}
function validateGridProps(props, path, issues) {
  validatePositiveInteger(props.rows, `${path}.rows`, issues);
  validatePositiveInteger(props.cols, `${path}.cols`, issues);
  if (props.cellSize !== undefined) {
    validatePositiveInteger(props.cellSize, `${path}.cellSize`, issues);
  }
  if (props.gap !== undefined) {
    validateNonNegativeInteger(props.gap, `${path}.gap`, issues);
  }
  if (props.backgroundColor !== undefined && readString(props.backgroundColor) == null) {
    addError(issues, `${path}.backgroundColor`, "Grid.backgroundColor must be a string");
  }
  if (props.children !== undefined) {
    validateChildren(props.children, `${path}.children`, issues);
  }
  if (props.cellBackgrounds !== undefined && !isRecord(props.cellBackgrounds)) {
    addError(issues, `${path}.cellBackgrounds`, "Grid.cellBackgrounds must be a bound value");
  }
}
function validateChildReferences(surface, value, ownerId, issues) {
  const childIds = readChildIds(value);
  if (childIds == null) {
    return;
  }
  for (const childId of childIds) {
    if (!surface.components.has(childId)) {
      addError(
        issues,
        `$.surface(${surface.surfaceId}).component(${ownerId}).children`,
        `Unknown child component '${childId}'`,
      );
    }
  }
}
function assertReferencedType(surface, componentId, expectedType, ownerId, field, issues) {
  if (!surface.components.has(componentId)) {
    addError(
      issues,
      `$.surface(${surface.surfaceId}).component(${ownerId}).${field}`,
      `Unknown referenced component '${componentId}'`,
    );
    return;
  }
  const ref = readComponentRef(surface, componentId);
  if (ref.type !== expectedType) {
    addError(
      issues,
      `$.surface(${surface.surfaceId}).component(${ownerId}).${field}`,
      `${field} must reference a ${expectedType} component, got ${ref.type}`,
    );
  }
}
function validateChildren(value, path, issues) {
  if (!isRecord(value) || !Array.isArray(value.explicitList)) {
    addError(issues, path, "children.explicitList is required");
    return;
  }
  for (const [index, child] of value.explicitList.entries()) {
    if (readString(child) == null) {
      addError(issues, `${path}.explicitList[${index}]`, "Child id must be a string");
    }
  }
}
function validateAction(value, path, issues) {
  if (!isRecord(value)) {
    addError(issues, path, "Button.action is required");
    return;
  }
  if (readString(value.name) == null) {
    addError(issues, `${path}.name`, "Button.action.name is required");
  }
  if (value.context !== undefined && !Array.isArray(value.context)) {
    addError(issues, `${path}.context`, "Button.action.context must be an array when provided");
  }
}
function validateBoundString(value, path, issues) {
  if (!isRecord(value)) {
    addError(issues, path, "Bound string value is required");
    return;
  }
  const hasLiteral = typeof value.literalString === "string";
  const hasPath = typeof value.path === "string";
  if (!hasLiteral && !hasPath) {
    addError(issues, path, "Use literalString for fixed text or path for data-model text");
  }
}
function validatePositiveInteger(value, path, issues) {
  if (!Number.isInteger(value) || value < 1) {
    addError(issues, path, "Value must be a positive integer");
  }
}
function validateNonNegativeInteger(value, path, issues) {
  if (!Number.isInteger(value) || value < 0) {
    addError(issues, path, "Value must be a non-negative integer");
  }
}
function validateDataEntry(value, path, issues) {
  if (!isRecord(value)) {
    addError(issues, path, "Data entry must be an object");
    return;
  }
  if (readString(value.key) == null) {
    addError(issues, `${path}.key`, "Data entry key is required");
  }
  const valueFields = ["valueString", "valueNumber", "valueBoolean", "valueMap"].filter(
    (field) => field in value,
  );
  if (valueFields.length !== 1) {
    addError(issues, path, "Data entry must contain exactly one value* field");
  }
  if (Array.isArray(value.valueMap)) {
    value.valueMap.forEach((entry, index) => {
      validateDataEntry(entry, `${path}.valueMap[${index}]`, issues);
    });
  }
}
function readChildIds(value) {
  if (!isRecord(value) || !Array.isArray(value.explicitList)) {
    return null;
  }
  return value.explicitList.filter((entry) => typeof entry === "string");
}
function ensureComponentSet(map, surfaceId) {
  const existing = map.get(surfaceId);
  if (existing != null) {
    return existing;
  }
  const created = new Set();
  map.set(surfaceId, created);
  return created;
}
function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function addError(issues, path, message) {
  issues.push({ path, message, severity: "error" });
}
function hasErrors(issues) {
  return issues.some((issue) => issue.severity === "error");
}
