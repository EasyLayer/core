import { Buffer } from 'buffer';
import { v4 as uuidv4 } from 'uuid';
import type { BaseTransportOptions, RateLimits } from '../../../core';
import { BaseTransport } from '../../../core';

export interface RPCTransportOptions extends BaseTransportOptions {
  baseUrl: string;
  responseTimeout?: number;
}

function toBase64(str: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str).toString('base64');
  }
  if (typeof btoa !== 'undefined') {
    return btoa(str);
  }
  return (globalThis as any).btoa?.(str) ?? '';
}

function uuid(): string {
  try {
    return uuidv4();
  } catch {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      // @ts-ignore
      return crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/** Returns true when Buffer API is available at runtime. */
function hasNodeBuffer(): boolean {
  return typeof Buffer !== 'undefined' && typeof Buffer.from === 'function';
}

/** Hex → Uint8Array (browser-safe) */
function hexToU8(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : '0' + hex;
  const len = clean.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const byte = Number('0x' + clean.substr(i * 2, 2));
    out[i] = byte;
  }
  return out;
}

/**
 * Convert arbitrary byte-like data to a Buffer at runtime when Buffer exists.
 * In the browser we keep Uint8Array but type-cast to Buffer to satisfy BaseTransport's signature.
 * Consumers should treat it as read-only bytes and not call Buffer-specific APIs in the browser.
 */
function toBufferLike(u8: Uint8Array): Buffer {
  return hasNodeBuffer() ? Buffer.from(u8) : (u8 as unknown as Buffer);
}

/**
 * RPC Transport with guaranteed request-response order via UUID matching
 *
 * Core Architecture:
 * 1. Each RPC call gets unique UUID for identification
 * 2. Server can return responses in any order (JSON-RPC 2.0 spec)
 * 3. We match responses to requests using UUID
 * 4. Missing/failed responses are filled with null values
 * 5. Final result array maintains exact order correspondence with input
 *
 * Order Guarantees:
 * - Input requests[i] always corresponds to output results[i]
 * - RateLimiter preserves order through batching
 * - UUID matching eliminates dependency on server response order
 * - null values maintain array positions for failed requests
 *
 * Example:
 * Input:  [req_A, req_B, req_C]
 * UUIDs:  [uuid1, uuid2, uuid3]
 * Server: [{id:uuid3,result:C}, {id:uuid1,result:A}]
 * Output: [A, null, C]
 */
export class RPCTransport extends BaseTransport<RPCTransportOptions> {
  readonly type = 'rpc';

  private baseUrl: string;
  private username?: string;
  private password?: string;
  private responseTimeout: number;

  constructor(options: RPCTransportOptions) {
    super(options);

    const url = new URL(options.baseUrl);
    this.username = url.username || undefined;
    this.password = url.password || undefined;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();

    this.responseTimeout = options.responseTimeout ?? 5000;
  }

  get connectionOptions(): RPCTransportOptions {
    return {
      uniqName: this.uniqName,
      baseUrl: this.baseUrl,
      rateLimits: (this.rateLimiter as unknown as { config: Required<RateLimits> })['config'],
      network: this.network,
      responseTimeout: this.responseTimeout,
    };
  }

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      const ok = await this.healthcheck();
      if (!ok) throw new Error('Cannot connect to RPC node');
      this.isConnected = true;
    }, 'connect');
  }

  async disconnect(): Promise<void> {
    await this.rateLimiter.stop();
    this.isConnected = false;
  }

  async healthcheck(): Promise<boolean> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall(calls)
      );
      return results[0] !== null && results[0] !== undefined;
    } catch {
      return false;
    }
  }

  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.rateLimiter.execute([{ method: 'getblockcount', params: [] }], (calls) =>
        this.batchCall(calls)
      );
      const height = results[0];
      if (height === null || height === undefined) {
        throw new Error('Failed to get block height: null response from RPC server');
      }
      return height;
    }, 'getBlockHeight');
  }

  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({ method: 'getblockhash', params: [height] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this.batchCall(calls));
      return results.map((hash) => hash || null);
    }, 'getManyBlockHashesByHeights');
  }

  public async requestHexBlocks(hashes: string[]): Promise<(Buffer | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] }));
      const hexResults = await this.rateLimiter.execute(requests, (calls) => this.batchCall<string>(calls));

      const out: (Buffer | null)[] = new Array(hashes.length);
      for (let i = 0; i < hexResults.length; i++) {
        const hex = hexResults[i];
        if (typeof hex !== 'string') {
          out[i] = null;
          continue;
        }
        if (hasNodeBuffer()) {
          out[i] = Buffer.from(hex, 'hex');
        } else {
          const u8 = hexToU8(hex);
          out[i] = toBufferLike(u8);
        }
      }
      return out;
    }, 'requestHexBlocks');
  }

  async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      if (this.username && this.password) {
        const auth = toBase64(`${this.username}:${this.password}`);
        headers.set('Authorization', `Basic ${auth}`);
      }

      const callsWithIds = calls.map((call) => ({ ...call, id: uuid() }));
      const payload = callsWithIds.map((call) => ({
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: call.id,
      }));

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.responseTimeout);

      try {
        const init: RequestInit = {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ac.signal,
        };

        const response = await fetch(this.baseUrl, init);
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const raw = await response.json();
        const array = Array.isArray(raw) ? raw : [raw];

        const responseMap = new Map<string | number, { result?: any; error?: any }>();
        for (const r of array) {
          const id = r?.id;
          if (typeof id === 'string' || typeof id === 'number') {
            if (!responseMap.has(id)) responseMap.set(id, r);
          }
        }

        return callsWithIds.map((call) => {
          const r = responseMap.get(call.id);
          if (!r || r.error != null) return null;
          return (r.result ?? null) as TResult | null;
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          throw new Error(`RPC timeout after ${this.responseTimeout}ms at ${this.baseUrl}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }, 'batchCall');
  }

  subscribeToNewBlocks(): { unsubscribe: () => void } {
    throw new Error('Subscriptions are not supported in browser RPC transport');
  }
}
