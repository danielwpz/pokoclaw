import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { type LoadConfigOptions, loadConfig } from "@/src/config/load.js";
import type { AppConfig } from "@/src/config/schema.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("config/live-manager");
const DEFAULT_WATCH_DEBOUNCE_MS = 150;

export interface LiveConfigManagerOptions {
  initialSnapshot: AppConfig;
  filePaths?: Required<LoadConfigOptions>;
  watchDebounceMs?: number;
}

export interface LiveConfigChangeEvent {
  version: number;
  snapshot: AppConfig;
  reason: string;
}

export interface ReloadConfigResult {
  reloaded: boolean;
  version: number;
  reason: string;
}

export class LiveConfigManager {
  private snapshot: AppConfig;
  private snapshotJson: string;
  private version = 1;
  private readonly listeners = new Set<(event: LiveConfigChangeEvent) => void>();
  private readonly watchDebounceMs: number;
  private readonly watchers = new Map<string, FSWatcher>();
  private reloadPromise: Promise<ReloadConfigResult> | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private startedWatching = false;

  constructor(private readonly options: LiveConfigManagerOptions) {
    this.snapshot = options.initialSnapshot;
    this.snapshotJson = JSON.stringify(options.initialSnapshot);
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  }

  getSnapshot(): AppConfig {
    return this.snapshot;
  }

  getVersion(): number {
    return this.version;
  }

  getFilePaths(): Required<LoadConfigOptions> | null {
    return this.options.filePaths ?? null;
  }

  subscribe(listener: (event: LiveConfigChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async reloadFromDisk(reason = "manual_reload"): Promise<ReloadConfigResult> {
    if (this.options.filePaths == null) {
      throw new Error(
        "Live config reload is unavailable because no config file paths were configured.",
      );
    }
    if (this.reloadPromise != null) {
      return this.reloadPromise;
    }

    this.reloadPromise = (async () => {
      const nextSnapshot = await loadConfig(this.options.filePaths);
      return this.replaceSnapshot(nextSnapshot, reason);
    })().finally(() => {
      this.reloadPromise = null;
    });

    return this.reloadPromise;
  }

  startWatching(): void {
    if (this.startedWatching || this.options.filePaths == null) {
      return;
    }

    const watchedFiles = [
      this.options.filePaths.configTomlPath,
      this.options.filePaths.secretsTomlPath,
    ];
    const watchedBasenames = new Set(watchedFiles.map((filePath) => path.basename(filePath)));
    const watchedDirs = new Set(watchedFiles.map((filePath) => path.dirname(filePath)));

    for (const dirPath of watchedDirs) {
      try {
        const watcher = watch(dirPath, (_eventType, filename) => {
          const normalized = typeof filename === "string" ? filename : "";
          if (!watchedBasenames.has(normalized)) {
            return;
          }
          this.scheduleReload(`watch:${normalized}`);
        });
        this.watchers.set(dirPath, watcher);
      } catch (error: unknown) {
        logger.warn("failed to start config directory watcher", {
          dirPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.startedWatching = true;
    logger.info("live config watching started", {
      watcherCount: this.watchers.size,
      configTomlPath: this.options.filePaths.configTomlPath,
      secretsTomlPath: this.options.filePaths.secretsTomlPath,
    });
  }

  async shutdown(): Promise<void> {
    if (this.watchTimer != null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.startedWatching = false;
  }

  private scheduleReload(reason: string): void {
    if (this.watchTimer != null) {
      clearTimeout(this.watchTimer);
    }

    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.reloadFromDisk(reason).catch((error: unknown) => {
        logger.warn("live config reload failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.watchDebounceMs);
  }

  private replaceSnapshot(nextSnapshot: AppConfig, reason: string): ReloadConfigResult {
    const nextJson = JSON.stringify(nextSnapshot);
    if (nextJson === this.snapshotJson) {
      logger.debug("live config reload skipped because snapshot was unchanged", {
        reason,
        version: this.version,
      });
      return {
        reloaded: false,
        version: this.version,
        reason,
      };
    }

    this.snapshot = nextSnapshot;
    this.snapshotJson = nextJson;
    this.version += 1;
    logger.info("live config snapshot replaced", {
      reason,
      version: this.version,
    });

    const event: LiveConfigChangeEvent = {
      version: this.version,
      snapshot: this.snapshot,
      reason,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        logger.warn("live config subscriber threw during notification", {
          reason,
          version: this.version,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      reloaded: true,
      version: this.version,
      reason,
    };
  }
}
