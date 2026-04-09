import { ProviderRegistry } from "@/src/agent/llm/provider-registry.js";
import type { LiveConfigManager } from "@/src/config/live-manager.js";
import type { AppConfig } from "@/src/config/schema.js";

export interface ProviderRegistrySource {
  current(): ProviderRegistry;
}

export class StaticProviderRegistrySource implements ProviderRegistrySource {
  constructor(private readonly registry: ProviderRegistry) {}

  current(): ProviderRegistry {
    return this.registry;
  }
}

export class LiveProviderRegistrySource implements ProviderRegistrySource {
  private version = -1;
  private registry: ProviderRegistry | null = null;

  constructor(private readonly config: Pick<LiveConfigManager, "getSnapshot" | "getVersion">) {}

  current(): ProviderRegistry {
    const currentVersion = this.config.getVersion();
    if (this.registry != null && this.version === currentVersion) {
      return this.registry;
    }

    this.registry = new ProviderRegistry(selectModelConfig(this.config.getSnapshot()));
    this.version = currentVersion;
    return this.registry;
  }
}

export function resolveProviderRegistry(
  input: ProviderRegistry | ProviderRegistrySource,
): ProviderRegistry {
  return input instanceof ProviderRegistry ? input : input.current();
}

function selectModelConfig(snapshot: AppConfig): Pick<AppConfig, "providers" | "models"> {
  return {
    providers: snapshot.providers,
    models: snapshot.models,
  };
}
