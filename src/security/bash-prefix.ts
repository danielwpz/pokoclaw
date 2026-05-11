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
}

export interface BashCommandRedirect {
  operator: string;
  destination: string;
}

export interface BashCommandSegment extends SimpleBashCommand {
  redirects: BashCommandRedirect[];
  stdinFromPipe: boolean;
  stdoutToPipe: boolean;
}

export interface ParsedBashCommandSequence {
  kind: "simple" | "compound";
  commands: BashCommandSegment[];
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
      const commands = extractCommandSequence(tree.rootNode, {
        inheritedRedirects: [],
        stdinFromPipe: false,
        stdoutToPipe: false,
      });
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

export function parseSimpleBashCommand(command: string): BashCommandSegment | null {
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

interface BashCommandExtractContext {
  inheritedRedirects: BashCommandRedirect[];
  stdinFromPipe: boolean;
  stdoutToPipe: boolean;
}

function extractCommandSequence(
  node: Node,
  context: BashCommandExtractContext,
): BashCommandSegment[] | null {
  switch (node.type) {
    case "program":
    case "list": {
      return extractFlatCommandSequence(node.namedChildren, context);
    }
    case "pipeline": {
      const commands: BashCommandSegment[] = [];
      const children = node.namedChildren;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child == null) {
          return null;
        }
        const extracted = extractCommandSequence(child, {
          ...context,
          stdinFromPipe: context.stdinFromPipe || index > 0,
          stdoutToPipe: context.stdoutToPipe || index < children.length - 1,
        });
        if (extracted == null) {
          return null;
        }
        commands.push(...extracted);
      }
      return commands;
    }
    case "redirected_statement": {
      return extractRedirectedStatement(node, context);
    }
    case "command": {
      const command = extractPlainCommand(node);
      return command == null
        ? null
        : [
            {
              ...command,
              redirects: [...context.inheritedRedirects],
              stdinFromPipe: context.stdinFromPipe,
              stdoutToPipe: context.stdoutToPipe,
            },
          ];
    }
    default:
      return null;
  }
}

function extractFlatCommandSequence(
  nodes: readonly Node[],
  context: BashCommandExtractContext,
): BashCommandSegment[] | null {
  const commands: BashCommandSegment[] = [];
  for (const child of nodes) {
    const extracted = extractCommandSequence(child, context);
    if (extracted == null) {
      return null;
    }
    commands.push(...extracted);
  }
  return commands;
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
      case "concatenation":
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

function extractRedirectedStatement(
  node: Node,
  context: BashCommandExtractContext,
): BashCommandSegment[] | null {
  const body = node.childForFieldName("body");
  if (body == null) {
    return null;
  }

  const redirects = node.namedChildren.filter((child) => child.type === "file_redirect");
  if (redirects.length === 0) {
    return null;
  }

  const parsedRedirects: BashCommandRedirect[] = [];
  for (const redirect of redirects) {
    const parsedRedirect = extractSupportedOutputRedirect(redirect);
    if (parsedRedirect == null) {
      return null;
    }
    parsedRedirects.push(parsedRedirect);
  }

  return extractCommandSequence(body, {
    ...context,
    inheritedRedirects: [...context.inheritedRedirects, ...parsedRedirects],
  });
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
    case "concatenation":
      return extractConcatenatedLiteral(node);
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

function extractConcatenatedLiteral(node: Node): string | null {
  const parts: string[] = [];

  for (const child of node.namedChildren) {
    const part = extractLiteralWord(child);
    if (part == null) {
      return null;
    }
    parts.push(part);
  }

  return parts.join("");
}

function extractSupportedOutputRedirect(node: Node): BashCommandRedirect | null {
  if (node.type !== "file_redirect") {
    return null;
  }

  const operator = readRedirectOperator(node);
  if (operator == null) {
    return null;
  }

  switch (operator) {
    case ">":
    case ">>":
    case ">|":
    case "&>":
    case "&>>": {
      const destination = readLiteralRedirectDestination(node);
      return destination == null ? null : { operator, destination };
    }
    case ">&":
      return readFileDescriptorDuplicationDestination(node, operator);
    default:
      return null;
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

function readLiteralRedirectDestination(node: Node): string | null {
  const destination = readRedirectDestinationNodes(node);
  if (destination.length === 0) {
    return null;
  }

  const literalDestinations = destination.map((entry) => extractLiteralWord(entry));
  if (literalDestinations.some((entry) => entry == null)) {
    return null;
  }

  return literalDestinations.join(" ");
}

function readFileDescriptorDuplicationDestination(
  node: Node,
  operator: string,
): BashCommandRedirect | null {
  const destination = readRedirectDestinationNodes(node);
  if (destination.length !== 1) {
    return null;
  }

  const [entry] = destination;
  return entry?.type === "number" ? { operator, destination: entry.text } : null;
}

function readRedirectDestinationNodes(node: Node): Node[] {
  const destination = node.childrenForFieldName("destination");
  if (destination.length > 0) {
    return destination;
  }

  const lastNamedChild = node.namedChildren.at(-1);
  return lastNamedChild == null ? [] : [lastNamedChild];
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
