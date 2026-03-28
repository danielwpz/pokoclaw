import { afterEach, describe, expect, test, vi } from "vitest";

import { createLarkChannelRuntime } from "@/src/channels/lark/channel.js";
import {
  createTestDatabase,
  destroyTestDatabase,
  type TestDatabaseHandle,
} from "@/tests/storage/helpers/test-db.js";

describe("Lark channel runtime", () => {
  let handle: TestDatabaseHandle | null = null;

  afterEach(async () => {
    if (handle != null) {
      await destroyTestDatabase(handle);
      handle = null;
    }
  });

  test("starts only configured enabled installations", async () => {
    handle = await createTestDatabase(import.meta.url);
    const wsStart = vi.fn();
    const wsClose = vi.fn();

    const runtime = createLarkChannelRuntime({
      config: {
        installations: {
          default: {
            enabled: true,
            appId: "cli_123",
            appSecret: "secret_123",
            connectionMode: "websocket",
          },
          skipped: {
            enabled: true,
            connectionMode: "websocket",
          },
        },
      },
      storage: handle.storage.db,
      ingress: {
        submitMessage: vi.fn(async () => ({ status: "started" as const })),
      },
      wsClientFactory: () =>
        ({
          start: wsStart,
          close: wsClose,
        }) as never,
    });

    runtime.start();

    expect(runtime.status()).toEqual({
      started: true,
      enabledInstallations: 2,
      configuredInstallations: 1,
      activeClients: 0,
      activeInboundSockets: 1,
    });
    expect(wsStart).toHaveBeenCalledOnce();

    await runtime.shutdown();
    expect(runtime.status()).toEqual({
      started: false,
      enabledInstallations: 2,
      configuredInstallations: 1,
      activeClients: 0,
      activeInboundSockets: 0,
    });
    expect(wsClose).toHaveBeenCalledOnce();
  });
});
