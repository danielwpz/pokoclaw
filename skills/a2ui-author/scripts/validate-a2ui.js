#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportedVersions = new Set(["v0_8"]);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!supportedVersions.has(options.version)) {
    throw new Error(
      `Unsupported version '${options.version}'. Supported versions: ${[...supportedVersions].join(", ")}`,
    );
  }
  if (options.file == null) {
    printHelp();
    process.exit(1);
  }

  const inputPath = resolve(process.cwd(), options.file);
  const input = readJsonFile(inputPath);
  const runtime = await loadRuntime(options.version);
  const validation = runtime.validateA2uiMessages(input);

  if (!validation.ok) {
    console.error("A2UI validation failed");
    console.error(runtime.formatValidationIssues(validation.issues));
    process.exit(1);
  }

  const store = new runtime.SurfaceStore();
  store.applyMessages(input);

  console.log("A2UI validation passed");
  console.log(`version: ${options.version}`);
  console.log(`file: ${options.file}`);
  console.log(`surfaces: ${validation.renderedSurfaceIds.length}`);

  for (const surfaceId of validation.renderedSurfaceIds) {
    const rendered = runtime.renderSurface(store.getSurface(surfaceId));
    console.log(
      `- ${surfaceId}: callbacks=${rendered.callbackBindings.length}, warnings=${rendered.warnings.length}`,
    );
    for (const warning of rendered.warnings) {
      console.log(`  warning ${warning.code}: ${warning.message}`);
    }
  }
}

function parseArgs(args) {
  const options = {
    version: "v0_8",
    file: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--version") {
      const value = args[index + 1];
      if (value == null || value.startsWith("-")) {
        throw new Error("--version requires a value");
      }
      options.version = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.file != null) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    options.file = arg;
  }

  return options;
}

async function loadRuntime(version) {
  const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runtimePath = join(skillDir, "runtime", version, "index.js");
  if (!existsSync(runtimePath)) {
    throw new Error(`Missing bundled runtime '${runtimePath}'. This skill package is incomplete.`);
  }
  return await import(pathToFileURL(runtimePath).href);
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

function printHelp() {
  console.log(`Usage: node skills/scripts/validate-a2ui.js [--version v0_8] <a2ui-messages.json>

Validates A2UI server messages against the bundled lark-a2ui-renderer runtime.

Options:
  --version <version>  Protocol/runtime version to use. Default: v0_8
  -h, --help           Show this help message`);
}
