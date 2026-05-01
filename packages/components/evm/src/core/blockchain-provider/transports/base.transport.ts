import type { JsonRpcRequest, JsonRpcTransport } from './interfaces';
import { RpcError } from './errors';

export abstract class BaseTransport implements JsonRpcTransport {
  abstract request<T = any>(method: string, params?: any[]): Promise<T>;

  async batch<T = any>(requests: JsonRpcRequest[]): Promise<Array<T | null>> {
    const results: Array<T | null> = [];
    for (const req of requests) {
      try {
        results.push(await this.request<T>(req.method, req.params));
      } catch (error) {
        results.push(null);
      }
    }
    return results;
  }

  close(): Promise<void> | void {}

  protected normalizeError(error: unknown, method: string): RpcError {
    const message = error instanceof Error ? error.message : String(error);
    return new RpcError(`EVM JSON-RPC ${method} failed: ${message}`, error);
  }
}
