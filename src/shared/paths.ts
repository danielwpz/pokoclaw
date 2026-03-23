import { homedir } from "node:os";
import path from "node:path";

export const POKECLAW_HOME_DIR = path.join(homedir(), ".pokeclaw");
export const POKECLAW_SYSTEM_DIR = path.join(POKECLAW_HOME_DIR, "system");
export const POKECLAW_WORKSPACE_DIR = path.join(POKECLAW_HOME_DIR, "workspace");

export const DEFAULT_CONFIG_TOML_PATH = path.join(POKECLAW_SYSTEM_DIR, "config.toml");
export const DEFAULT_SECRETS_TOML_PATH = path.join(POKECLAW_SYSTEM_DIR, "secrets.toml");
