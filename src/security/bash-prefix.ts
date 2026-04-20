import path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";

import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("security/bash-prefix");

const WEB_TREE_SITTER_WASM_PATH = fileURLToPath(
  new URL("../../node_modules/web-tree-sitter/web-tree-sitter.wasm", import.meta.url),
);
const TREE_SITTER_BASH_WASM_PATH = fileURLToPath(
  new URL("../../node_modules/tree-sitter-bash/tree-sitter-bash.wasm", import.meta.url),
);

export interface SimpleBashCommand {
  envAssignments: string[];
  argv: string[];
  hasOutputRedirect?: boolean;
}

export interface ParsedBashCommandSequence {
  kind: "simple" | "compound";
  commands: SimpleBashCommand[];
}

type BashParserState =
  | {
      available: true;
      language: Language;
    }
  | {
      available: false;
      reason: string;
    };

const bashParserState = await initializeBashParserState();

export function parseConservativeBashCommandSequence(
  command: string,
): ParsedBashCommandSequence | null {
  if (!bashParserState.available) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(bashParserState.language);

  try {
    const tree = parser.parse(command);
    if (tree == null) {
      return null;
    }

    try {
      const commands = extractCommandSequence(tree.rootNode);
      if (commands == null || commands.length === 0) {
        return null;
      }

      return {
        kind: commands.length === 1 ? "simple" : "compound",
        commands,
      };
    } finally {
      tree.delete();
    }
  } catch (error) {
    logger.warn("failed to parse bash command sequence", {
      error: error instanceof Error ? error.message : String(error),
      commandPreview: command.slice(0, 200),
    });
    return null;
  } finally {
    parser.delete();
  }
}

export function parseSimpleBashCommand(command: string): SimpleBashCommand | null {
  const parsed = parseConservativeBashCommandSequence(command);
  if (parsed?.kind !== "simple") {
    return null;
  }

  return parsed.commands[0] ?? null;
}

export function normalizeBashCommandPrefix(command: string): string[] | null {
  return parseSimpleBashCommand(command)?.argv ?? null;
}

export function bashPrefixMatchesCommand(prefix: string[], commandArgv: string[]): boolean {
  if (prefix.length === 0 || prefix.length > commandArgv.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== commandArgv[index]) {
      return false;
    }
  }

  return true;
}

async function initializeBashParserState(): Promise<BashParserState> {
  try {
    await Parser.init({
      locateFile(scriptName: string) {
        if (scriptName === "web-tree-sitter.wasm") {
          return WEB_TREE_SITTER_WASM_PATH;
        }

        return path.join(path.dirname(WEB_TREE_SITTER_WASM_PATH), scriptName);
      },
    });

    const language = await Language.load(TREE_SITTER_BASH_WASM_PATH);
    return {
      available: true,
      language,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("failed to initialize bash parser", { reason });
    return {
      available: false,
      reason,
    };
  }
}

function extractCommandSequence(node: Node): SimpleBashCommand[] | null {
  switch (node.type) {
    case "program":
    case "list":
    case "pipeline": {
      const commands: SimpleBashCommand[] = [];
      for (const child of node.namedChildren) {
        const extracted = extractCommandSequence(child);
        if (extracted == null) {
          return null;
        }
        commands.push(...extracted);
      }
      return commands;
    }
    case "redirected_statement": {
      return extractRedirectedStatement(node);
    }
    case "command": {
      const command = extractPlainCommand(node);
      return command == null ? null : [command];
    }
    default:
      return null;
  }
}

function extractPlainCommand(node: Node): SimpleBashCommand | null {
  const envAssignments: string[] = [];
  const argv: string[] = [];

  for (const child of node.namedChildren) {
    switch (child.type) {
      case "variable_assignment": {
        const assignment = extractVariableAssignment(child);
        if (assignment == null) {
          return null;
        }
        envAssignments.push(assignment);
        break;
      }
      case "command_name":
      case "word":
      case "raw_string":
      case "string":
      case "number": {
        const literal = extractLiteralWord(child);
        if (literal == null) {
          return null;
        }
        argv.push(literal);
        break;
      }
      default:
        return null;
    }
  }

  if (argv.length === 0) {
    return null;
  }

  return {
    envAssignments,
    argv,
  };
}

function extractRedirectedStatement(node: Node): SimpleBashCommand[] | null {
  const body = node.childForFieldName("body");
  if (body == null) {
    return null;
  }

  const redirects = node.childrenForFieldName("redirect");
  if (redirects.length === 0) {
    return null;
  }

  for (const redirect of redirects) {
    if (!isSupportedOutputRedirect(redirect)) {
      return null;
    }
  }

  const commands = extractCommandSequence(body);
  if (commands == null) {
    return null;
  }

  return commands.map((command) => ({
    ...command,
    hasOutputRedirect: true,
  }));
}

function extractVariableAssignment(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode == null || nameNode.type !== "variable_name") {
    return null;
  }

  const valueNode = node.childForFieldName("value");
  if (valueNode == null) {
    return `${nameNode.text}=`;
  }

  const normalizedValue = extractLiteralWord(valueNode);
  if (normalizedValue == null) {
    return null;
  }

  return `${nameNode.text}=${normalizedValue}`;
}

function extractLiteralWord(node: Node): string | null {
  switch (node.type) {
    case "command_name":
      return extractCommandName(node);
    case "word":
      return containsUnsupportedExpansion(node) ? null : node.text;
    case "raw_string":
      return extractRawStringLiteral(node);
    case "string":
      return extractStringLiteral(node);
    case "number":
      return node.text;
    default:
      return null;
  }
}

function extractCommandName(node: Node): string | null {
  if (node.namedChildren.length !== 1) {
    return null;
  }

  const [child] = node.namedChildren;
  return child?.type === "word" && !containsUnsupportedExpansion(child) ? child.text : null;
}

function extractRawStringLiteral(node: Node): string | null {
  const text = node.text;
  if (text.length < 2 || !text.startsWith("'") || !text.endsWith("'")) {
    return null;
  }

  return text.slice(1, -1);
}

function extractStringLiteral(node: Node): string | null {
  if (containsUnsupportedExpansion(node)) {
    return null;
  }

  const allowedChildTypes = new Set(["string_content"]);
  if (node.namedChildren.some((child) => !allowedChildTypes.has(child.type))) {
    return null;
  }

  return node.namedChildren.map((child) => child.text).join("");
}

function isSupportedOutputRedirect(node: Node): boolean {
  if (node.type !== "file_redirect") {
    return false;
  }

  const operator = readRedirectOperator(node);
  if (operator == null) {
    return false;
  }

  switch (operator) {
    case ">":
    case ">>":
    case ">|":
    case "&>":
    case "&>>":
      return hasLiteralRedirectDestination(node);
    case ">&":
      return isFileDescriptorDuplication(node);
    default:
      return false;
  }
}

function readRedirectOperator(node: Node): string | null {
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child == null || child.isNamed) {
      continue;
    }

    return child.text;
  }

  return null;
}

function hasLiteralRedirectDestination(node: Node): boolean {
  const destination = node.childrenForFieldName("destination");
  if (destination.length === 0) {
    return false;
  }

  return destination.every((entry) => extractLiteralWord(entry) != null);
}

function isFileDescriptorDuplication(node: Node): boolean {
  const destination = node.childrenForFieldName("destination");
  if (destination.length !== 1) {
    return false;
  }

  return destination[0]?.type === "number";
}

function containsUnsupportedExpansion(node: Node): boolean {
  if (
    node.type === "command_substitution" ||
    node.type === "process_substitution" ||
    node.type === "simple_expansion" ||
    node.type === "expansion" ||
    node.type === "subshell"
  ) {
    return true;
  }

  return node.namedChildren.some((child) => containsUnsupportedExpansion(child));
}
