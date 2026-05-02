/**
 * Shared Feishu/Lark SDK client access for feishu tools.
 *
 * Wraps the LarkClientRegistry to provide SDK clients to feishu_doc and
 * feishu_base tools without duplicating config resolution logic.
 */
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { LarkClientRegistry } from "@/src/channels/lark/client.js";

export interface FeishuClientSource {
  getClient(installationId: string): Lark.Client;
}

export function createFeishuClientSource(registry: LarkClientRegistry): FeishuClientSource {
  return {
    getClient(installationId: string): Lark.Client {
      return registry.getOrCreate(installationId).sdk;
    },
  };
}

export type FeishuApiResult<T = unknown> = {
  code: number;
  msg: string;
  data?: T;
};

/**
 * Validates whether a raw Feishu API response indicates success.
 * Returns the data field on success, throws a recoverable error on failure.
 */
export function extractFeishuData<T>(result: FeishuApiResult<T>, context: string): T {
  if (result.code !== 0) {
    throw new Error(`Feishu API error (${context}): code=${result.code} msg=${result.msg}`);
  }
  if (result.data === undefined) {
    throw new Error(`Feishu API returned no data (${context})`);
  }
  return result.data;
}
