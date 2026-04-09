const MODELS_SCENARIOS_SECTION_HEADER = "[models.scenarios]";

export interface PatchScenarioModelListInput {
  tomlText: string;
  scenario: string;
  modelIds: string[];
}

export function patchScenarioModelListInToml(input: PatchScenarioModelListInput): string {
  const section = findSectionRange(input.tomlText, MODELS_SCENARIOS_SECTION_HEADER);
  const formattedSingleLine = formatTomlArray(input.modelIds, {
    multiline: false,
    indent: "",
  });

  if (section == null) {
    const separator =
      input.tomlText.trim().length === 0 ? "" : input.tomlText.endsWith("\n") ? "\n" : "\n\n";
    return [
      input.tomlText,
      separator,
      `${MODELS_SCENARIOS_SECTION_HEADER}\n${input.scenario} = ${formattedSingleLine}\n`,
    ].join("");
  }

  const sectionText = input.tomlText.slice(section.contentStart, section.contentEnd);
  const assignment = findScenarioAssignment(sectionText, input.scenario);
  if (assignment == null) {
    const insertion = `${input.scenario} = ${formattedSingleLine}\n`;
    return [
      input.tomlText.slice(0, section.contentEnd),
      needsLeadingNewline(sectionText) ? "\n" : "",
      insertion,
      input.tomlText.slice(section.contentEnd),
    ].join("");
  }

  const valueStart = section.contentStart + assignment.valueStart;
  const valueEnd = section.contentStart + assignment.valueEnd;
  const formatted = formatTomlArray(input.modelIds, {
    multiline: assignment.originalValue.includes("\n"),
    indent: assignment.indent,
  });
  return [input.tomlText.slice(0, valueStart), formatted, input.tomlText.slice(valueEnd)].join("");
}

function findSectionRange(
  text: string,
  header: string,
): { headerStart: number; contentStart: number; contentEnd: number } | null {
  const pattern = new RegExp(`^${escapeRegExp(header)}\\s*(?:#.*)?$`, "m");
  const match = pattern.exec(text);
  if (match == null || match.index == null) {
    return null;
  }

  const headerStart = match.index;
  const lineEnd = text.indexOf("\n", headerStart);
  const contentStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const nextHeaderPattern = /^\[[^\]]+\]\s*(?:#.*)?$/m;
  const nextHeaderMatch = nextHeaderPattern.exec(text.slice(contentStart));
  const contentEnd =
    nextHeaderMatch == null || nextHeaderMatch.index == null
      ? text.length
      : contentStart + nextHeaderMatch.index;

  return {
    headerStart,
    contentStart,
    contentEnd,
  };
}

function findScenarioAssignment(
  sectionText: string,
  scenario: string,
): { valueStart: number; valueEnd: number; indent: string; originalValue: string } | null {
  const pattern = new RegExp(`^([ \t]*)${escapeRegExp(scenario)}\\s*=`, "m");
  const match = pattern.exec(sectionText);
  if (match == null || match.index == null) {
    return null;
  }

  const indent = match[1] ?? "";
  const equalsIndex = sectionText.indexOf("=", match.index);
  if (equalsIndex === -1) {
    return null;
  }

  const valueStart = skipInlineWhitespace(sectionText, equalsIndex + 1);
  const valueEnd = findArrayValueEnd(sectionText, valueStart);
  const originalValue = sectionText.slice(valueStart, valueEnd);
  return {
    valueStart,
    valueEnd,
    indent,
    originalValue,
  };
}

function skipInlineWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

function findArrayValueEnd(text: string, start: number): number {
  if (text[start] !== "[") {
    throw new Error(`Expected TOML array value to start with '[' at index ${start}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  throw new Error("Failed to locate the closing bracket for models.scenarios array value.");
}

function formatTomlArray(
  modelIds: string[],
  input: {
    multiline: boolean;
    indent: string;
  },
): string {
  if (!input.multiline) {
    return `[${modelIds.map((value) => JSON.stringify(value)).join(", ")}]`;
  }

  const itemIndent = `${input.indent}  `;
  return [
    "[",
    ...modelIds.map((value) => `${itemIndent}${JSON.stringify(value)},`),
    `${input.indent}]`,
  ].join("\n");
}

function needsLeadingNewline(sectionText: string): boolean {
  return sectionText.length > 0 && !sectionText.endsWith("\n") && !sectionText.endsWith("\r\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
