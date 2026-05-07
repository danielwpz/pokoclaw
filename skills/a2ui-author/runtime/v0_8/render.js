import { isRecord, resolveBoundValue, resolveString } from "./json.js";
import { readComponentRef } from "./surface.js";
import { CALLBACK_ENVELOPE_VERSION } from "./types.js";

const LARK_EMPTY_GRID_CELL_MIN_SIZE_PX = 16;
export function renderSurface(surface) {
  if (surface.root == null) {
    throw new Error(`Surface '${surface.surfaceId}' has not received beginRendering`);
  }
  const context = {
    surface,
    callbackBindings: [],
    warnings: [],
    colorStyles: new Map(),
  };
  const rootComponent = readComponentRef(surface, surface.root);
  const isGridSurface = rootComponent.type === "Grid";
  const elements = renderNodeAsElements(context, surface.root);
  const summary = readStringStyle(surface.styles.summary) ?? summarizeElements(elements);
  const colorStyles = buildColorStyleConfig(context.colorStyles);
  return {
    surfaceId: surface.surfaceId,
    callbackBindings: context.callbackBindings,
    warnings: context.warnings,
    card: {
      schema: "2.0",
      config: {
        update_multi: true,
        wide_screen_mode: isGridSurface,
        summary: {
          content: summary,
        },
        ...(colorStyles == null
          ? {}
          : {
              style: {
                color: colorStyles,
              },
            }),
      },
      ...(isGridSurface
        ? {
            header: {
              title: {
                tag: "plain_text",
                content: summary,
              },
              template: "green",
            },
          }
        : {}),
      body: {
        elements,
      },
    },
  };
}
function renderNodeAsElements(context, componentId) {
  const component = readComponentRef(context.surface, componentId);
  switch (component.type) {
    case "Text":
      return [renderText(context, component.props)];
    case "Column":
      return renderChildren(context, readExplicitChildren(component.props.children));
    case "Row":
      return [renderRow(context, component.props)];
    case "Divider":
      return [{ tag: "hr" }];
    case "Button":
      return [renderButton(context, component.id, component.props)];
    case "Form":
      return [renderForm(context, component.id, component.props)];
    case "TextField":
      return [renderTextField(context, component.props)];
    case "MultipleChoice":
      return [renderMultipleChoice(context, component.props)];
    case "DateTimeInput":
      return [renderDateTimeInput(context, component.props)];
    case "Grid":
      return [renderGrid(context, component.id, component.props)];
    default:
      context.warnings.push({
        code: "UNSUPPORTED_COMPONENT",
        componentId,
        message: `Unsupported component type '${component.type}'`,
      });
      return [
        {
          tag: "markdown",
          content: `[Unsupported component: ${component.type}]`,
        },
      ];
  }
}
function renderGrid(context, componentId, props) {
  const rows = readPositiveInteger(props.rows, "Grid.rows", 1);
  const cols = readPositiveInteger(props.cols, "Grid.cols", 1);
  const requestedCellSize = readPositiveInteger(props.cellSize, "Grid.cellSize", 16);
  const gap = readNonNegativeInteger(props.gap, "Grid.gap", 0);
  const fallbackColor = readStringStyle(props.backgroundColor) ?? "#ffffff";
  const cellBackgrounds = resolveGridCellBackgrounds(
    props.cellBackgrounds,
    context.surface.dataModel,
  );
  const children = readOptionalExplicitChildren(props.children);
  const cellSize =
    children.length === 0
      ? Math.max(requestedCellSize, LARK_EMPTY_GRID_CELL_MIN_SIZE_PX)
      : requestedCellSize;
  const verticalPadding = `${Math.floor(cellSize / 2)}px 0px ${Math.floor(cellSize / 2)}px 0px`;
  const rowElements = Array.from({ length: rows }, (_, rowIndex) => ({
    tag: "column_set",
    element_id: `${componentId}_row_${rowIndex}`,
    flex_mode: "none",
    horizontal_spacing: `${gap}px`,
    horizontal_align: "left",
    margin: rowIndex === 0 ? "0px" : `${gap}px 0px 0px 0px`,
    background_style: "default",
    columns: Array.from({ length: cols }, (_, colIndex) => {
      const childId = children[rowIndex * cols + colIndex];
      const color = readGridCellColor(cellBackgrounds, rowIndex, colIndex) ?? fallbackColor;
      return {
        tag: "column",
        element_id: `${componentId}_px_${rowIndex}_${colIndex}`,
        width: `${cellSize}px`,
        vertical_align: "center",
        vertical_spacing: "0px",
        padding: verticalPadding,
        background_style: registerColorStyle(context, color),
        elements: childId == null ? [] : renderNodeAsElements(context, childId),
      };
    }),
  }));
  return {
    tag: "column_set",
    element_id: componentId,
    flex_mode: "none",
    horizontal_spacing: "0px",
    horizontal_align: "left",
    margin: "0px",
    background_style: "default",
    columns: [
      {
        tag: "column",
        element_id: `${componentId}_wrapper`,
        width: `${cols * cellSize + Math.max(0, cols - 1) * gap}px`,
        vertical_align: "top",
        vertical_spacing: "0px",
        padding: "0px",
        background_style: "default",
        elements: rowElements,
      },
    ],
  };
}
function renderText(context, props) {
  const content = resolveString(props.text, context.surface.dataModel);
  return {
    tag: "markdown",
    content,
  };
}
function renderRow(context, props) {
  const childIds = readExplicitChildren(props.children);
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_align: mapHorizontalAlign(props.distribution),
    columns: childIds.map((childId) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: renderNodeAsElements(context, childId),
    })),
  };
}
function renderForm(context, componentId, props) {
  const fieldIds = readExplicitChildren(props.children);
  const submitId = typeof props.submit === "string" ? props.submit : null;
  const elements = renderChildren(context, fieldIds);
  if (submitId != null) {
    elements.push(renderFormSubmitButton(context, submitId));
  }
  return {
    tag: "form",
    name: componentId,
    elements,
  };
}
function renderFormSubmitButton(context, componentId) {
  const component = readComponentRef(context.surface, componentId);
  if (component.type !== "Button") {
    context.warnings.push({
      code: "FORM_SUBMIT_NOT_BUTTON",
      componentId,
      message: "Form.submit should reference a Button component in the Lark card catalog",
    });
    return {
      tag: "markdown",
      content: `[Invalid form submit: ${component.type}]`,
    };
  }
  return renderButton(context, component.id, component.props, { actionType: "form_submit" });
}
function renderTextField(context, props) {
  return {
    tag: "input",
    name: readRequiredString(props.name, "TextField.name"),
    label: {
      tag: "plain_text",
      content: resolveString(props.label, context.surface.dataModel),
    },
    placeholder: {
      tag: "plain_text",
      content: resolveString(props.placeholder, context.surface.dataModel),
    },
    input_type: mapTextFieldType(props.textFieldType),
    default_value: resolveString(props.text, context.surface.dataModel),
    required: props.required === true,
    ...(typeof props.maxLength === "number" ? { max_length: props.maxLength } : {}),
  };
}
function renderMultipleChoice(context, props) {
  const options = Array.isArray(props.options) ? props.options : [];
  return {
    tag: "select_static",
    name: readRequiredString(props.name, "MultipleChoice.name"),
    placeholder: {
      tag: "plain_text",
      content: resolveString(props.label, context.surface.dataModel),
    },
    options: options.filter(isRecord).map((option) => ({
      text: {
        tag: "plain_text",
        content: resolveString(option.label, context.surface.dataModel),
      },
      value: readRequiredString(option.value, "MultipleChoice.options[].value"),
    })),
    required: props.required === true,
  };
}
function renderDateTimeInput(context, props) {
  return {
    tag: "date_picker",
    name: readRequiredString(props.name, "DateTimeInput.name"),
    placeholder: {
      tag: "plain_text",
      content: resolveString(props.label, context.surface.dataModel),
    },
    initial_date: resolveString(props.value, context.surface.dataModel),
    required: props.required === true,
  };
}
function renderButton(context, componentId, props, options = {}) {
  const childId = readRequiredString(props.child, "Button.child");
  const action = readButtonAction(props.action);
  const envelope = {
    __a2ui_lark: CALLBACK_ENVELOPE_VERSION,
    surfaceId: context.surface.surfaceId,
    sourceComponentId: componentId,
    actionName: action.name,
  };
  context.callbackBindings.push({
    envelope,
    actionName: action.name,
  });
  return {
    tag: "button",
    name: componentId,
    text: {
      tag: "plain_text",
      content: renderButtonLabel(context, childId),
    },
    ...(options.actionType == null ? {} : { action_type: options.actionType }),
    type: props.danger === true ? "danger" : props.primary === true ? "primary" : "default",
    value: envelope,
  };
}
function renderButtonLabel(context, childId) {
  const child = readComponentRef(context.surface, childId);
  if (child.type !== "Text") {
    context.warnings.push({
      code: "BUTTON_LABEL_NOT_TEXT",
      componentId: childId,
      message: "Button child should be a Text component in the Lark card catalog",
    });
    return childId;
  }
  return resolveString(child.props.text, context.surface.dataModel);
}
function renderChildren(context, childIds) {
  return childIds.flatMap((childId) => renderNodeAsElements(context, childId));
}
function readExplicitChildren(value) {
  if (!isRecord(value)) {
    throw new Error("children must be an object");
  }
  const childList = value;
  if (!Array.isArray(childList.explicitList)) {
    throw new Error("Only children.explicitList is supported in the first renderer version");
  }
  return childList.explicitList;
}
function readOptionalExplicitChildren(value) {
  if (value === undefined) {
    return [];
  }
  return readExplicitChildren(value);
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
function readRequiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}
function readStringStyle(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function readPositiveInteger(value, field, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`${field} must be a positive integer`);
}
function readNonNegativeInteger(value, field, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`${field} must be a non-negative integer`);
}
function resolveGridCellBackgrounds(value, dataModel) {
  if (value === undefined) {
    return undefined;
  }
  const resolved = resolveBoundValue(value, dataModel);
  if (resolved !== undefined) {
    return resolved;
  }
  return value;
}
function readGridCellColor(cells, rowIndex, colIndex) {
  if (!Array.isArray(cells)) {
    return null;
  }
  const row = cells[rowIndex];
  if (!Array.isArray(row)) {
    return null;
  }
  const cell = row[colIndex];
  return typeof cell === "string" && cell.length > 0 ? cell : null;
}
function registerColorStyle(context, color) {
  const normalized = normalizeCssColor(color);
  const existing = context.colorStyles.get(normalized);
  if (existing != null) {
    return existing;
  }
  const key = `a2ui_color_${context.colorStyles.size}`;
  context.colorStyles.set(normalized, key);
  return key;
}
function buildColorStyleConfig(colorStyles) {
  if (colorStyles.size === 0) {
    return null;
  }
  const styles = {};
  for (const [color, key] of colorStyles.entries()) {
    styles[key] = {
      light_mode: color,
      dark_mode: color,
    };
  }
  return styles;
}
function normalizeCssColor(color) {
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex?.[1] == null) {
    return trimmed;
  }
  const raw = hex[1];
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},1)`;
}
function mapHorizontalAlign(value) {
  if (value === "end") {
    return "right";
  }
  if (value === "center") {
    return "center";
  }
  return "left";
}
function mapTextFieldType(value) {
  if (value === "longText") {
    return "multiline_text";
  }
  if (value === "obscured") {
    return "password";
  }
  return "text";
}
function summarizeElements(elements) {
  const firstMarkdown = elements.find(
    (element) => element.tag === "markdown" && typeof element.content === "string",
  );
  if (firstMarkdown != null && typeof firstMarkdown.content === "string") {
    return firstMarkdown.content.slice(0, 120);
  }
  return "A2UI card";
}
