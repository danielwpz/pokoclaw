import * as Lark from "@larksuiteoapi/node-sdk";
import type { ConfiguredLarkInstallation } from "@/src/channels/lark/types.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";

const logger = createSubsystemLogger("channels/lark-client");

export class LarkClientRegistry {
  private readonly installations = new Map<string, ConfiguredLarkInstallation>();
  private readonly clients = new Map<string, Lark.Client>();

  constructor(installations: ConfiguredLarkInstallation[]) {
    for (const installation of installations) {
      this.installations.set(installation.installationId, installation);
    }
  }

  listInstallations(): ConfiguredLarkInstallation[] {
    return Array.from(this.installations.values());
  }

  getOrCreate(installationId: string): Lark.Client {
    const existing = this.clients.get(installationId);
    if (existing != null) {
      return existing;
    }

    const installation = this.installations.get(installationId);
    if (installation == null) {
      throw new Error(`Unknown Lark installation: ${installationId}`);
    }

    const client = new Lark.Client({
      appId: installation.appId,
      appSecret: installation.appSecret,
    });
    this.clients.set(installationId, client);

    logger.info("created lark sdk client", {
      installationId,
      connectionMode: installation.config.connectionMode,
    });

    return client;
  }

  activeClientCount(): number {
    return this.clients.size;
  }

  clear(): void {
    this.clients.clear();
    logger.debug("cleared lark sdk client registry");
  }
}
