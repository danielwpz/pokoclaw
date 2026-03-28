import type { LarkChannelConfig, LarkInstallationConfig } from "@/src/config/schema.js";

export interface LarkInstallationDescriptor {
  installationId: string;
  config: LarkInstallationConfig;
}

export interface ConfiguredLarkInstallation extends LarkInstallationDescriptor {
  appId: string;
  appSecret: string;
}

export function listEnabledLarkInstallations(
  config: LarkChannelConfig,
): LarkInstallationDescriptor[] {
  return Object.entries(config.installations)
    .filter(([, installation]) => installation.enabled)
    .map(([installationId, installation]) => ({
      installationId,
      config: installation,
    }));
}

export function isConfiguredLarkInstallation(
  installation: LarkInstallationDescriptor,
): installation is ConfiguredLarkInstallation {
  return (
    typeof installation.config.appId === "string" &&
    installation.config.appId.length > 0 &&
    typeof installation.config.appSecret === "string" &&
    installation.config.appSecret.length > 0
  );
}

export function listConfiguredLarkInstallations(
  config: LarkChannelConfig,
): ConfiguredLarkInstallation[] {
  return listEnabledLarkInstallations(config)
    .filter(isConfiguredLarkInstallation)
    .map((installation) => {
      const { appId, appSecret } = installation.config;
      if (appId == null || appSecret == null) {
        throw new Error(
          `Configured Lark installation ${installation.installationId} is missing credentials`,
        );
      }

      return {
        installationId: installation.installationId,
        config: installation.config,
        appId,
        appSecret,
      };
    });
}
