import { BaseTransport } from '../../../core/blockchain-provider/transports/base.transport';
import { RateLimiter } from '../../../core/blockchain-provider/transports/rate-limiter';
import { RpcError } from '../../../core/blockchain-provider/transports/errors';
import type { JsonRpcRequest } from '../../../core/blockchain-provider/transports/interfaces';
import type { RateLimits } from '../../../core/blockchain-provider/providers';

export interface NodeRpcTransportOptions {
  uniqName: string;
  httpUrl: string;
  responseTimeout?: number;
  rateLimits?: RateLimits;
  headers?: Record<string, string>;
}

export class NodeRpcTransport extends BaseTransport {
  public readonly type = 'node-rpc' as const;

  private readonly httpUrl: string;
  private readonly responseTimeout: number;
  private readonly rateLimiter: RateLimiter;
  private readonly headers: Record<string, string>;
  private requestId = 1;

  constructor(options: NodeRpcTransportOptions) {
    super();

    const url = new URL(options.httpUrl);
    const basicAuth = url.username
      ? `Basic ${this.encodeBase64(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`
      : undefined;

    url.username = '';
    url.password = '';

    this.httpUrl = url.toString();
    this.responseTimeout = options.responseTimeout ?? 5000;
    this.rateLimiter = new RateLimiter(options.rateLimits ?? {});
    this.headers = {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
      ...(basicAuth ? { Authorization: basicAuth } : {}),
    };
  }

  async request<T = any>(method: string, params: any[] = []): Promise<T> {
    try {
      const [result] = await this.batch<T>([{ method, params }]);
      if (result === null || result === undefined) {
        throw new RpcError(`EVM JSON-RPC ${method} returned empty result`);
      }
      return result;
    } catch (error) {
      throw this.normalizeError(error, method);
    }
  }

  async batch<T = any>(requests: JsonRpcRequest[]): Promise<Array<T | null>> {
    try {
      return await this.rateLimiter.execute<T>(requests, async (calls) => this.batchCall<T>(calls));
    } catch (error) {
      throw this.normalizeError(error, 'batch');
    }
  }

  async close(): Promise<void> {
    await this.rateLimiter.stop();
  }

  private async batchCall<T = any>(calls: JsonRpcRequest[]): Promise<Array<T | null>> {
    if (calls.length === 0) return [];

    const payload = calls.map((call) => ({
      jsonrpc: '2.0',
      id: this.requestId++,
      method: call.method,
      params: call.params,
    }));
    const idToIndex = new Map<number, number>(payload.map((item, index) => [item.id, index]));

    const response = await fetch(this.httpUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.responseTimeout),
    });

    if (!response.ok) {
      throw new RpcError(`EVM JSON-RPC batch failed with HTTP ${response.status}: ${response.statusText}`);
    }

    const raw = await response.json();
    const items = Array.isArray(raw) ? raw : [raw];
    const results: Array<T | null> = new Array(calls.length).fill(null);

    for (const item of items) {
      const index = typeof item?.id === 'number' ? idToIndex.get(item.id) : undefined;
      if (index == null) continue;
      if (item?.error) {
        throw new RpcError(`JSON-RPC Error ${item.error.code}: ${item.error.message}`, item.error);
      }
      results[index] = (item?.result ?? null) as T | null;
    }

    return results;
  }

  private encodeBase64(value: string): string {
    if (typeof btoa === 'function') {
      return btoa(value);
    }

    if (typeof globalThis === 'object' && typeof (globalThis as any).Buffer !== 'undefined') {
      return (globalThis as any).Buffer.from(value).toString('base64');
    }

    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value) : undefined;
    if (!bytes) {
      throw new Error('Base64 encoding is not available in this runtime');
    }

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i] ?? 0;
      const b = bytes[i + 1] ?? 0;
      const c = bytes[i + 2] ?? 0;
      const triple = (a << 16) | (b << 8) | c;
      out += alphabet[(triple >> 18) & 63];
      out += alphabet[(triple >> 12) & 63];
      out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '=';
      out += i + 2 < bytes.length ? alphabet[triple & 63] : '=';
    }
    return out;
  }
}
