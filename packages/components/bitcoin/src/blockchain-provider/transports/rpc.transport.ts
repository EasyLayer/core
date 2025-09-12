import { Agent as UndiciAgent } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import * as zmq from 'zeromq';
import { v4 as uuidv4 } from 'uuid';
import type { BaseTransportOptions } from './base.transport';
import { BaseTransport } from './base.transport';

export interface RPCTransportOptions extends BaseTransportOptions {
  baseUrl: string;
  responseTimeout?: number;
  zmqEndpoint?: string;
}

type BlockSubscriber = {
  onData: (blockData: Buffer) => void;
  onError?: (err: Error) => void;
};

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

  private static sharedDispatcher: UndiciAgent | null = null;

  private baseUrl: string;
  private username?: string;
  private password?: string;
  private responseTimeout: number;

  private _dispatcher: UndiciAgent | null = null;

  private zmqEndpoint?: string;
  private zmqSocket?: zmq.Subscriber;
  private zmqRunning = false;
  private blockSubscriptions = new Set<BlockSubscriber>();

  private zmqReconnectAttempts = 0;
  private zmqReconnectTimer?: NodeJS.Timeout;

  constructor(options: RPCTransportOptions) {
    super(options);

    const url = new URL(options.baseUrl);
    this.username = url.username || undefined;
    this.password = url.password || undefined;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();

    this.responseTimeout = options.responseTimeout ?? 5000;
    this.zmqEndpoint = options.zmqEndpoint;

    if (!RPCTransport.sharedDispatcher) {
      RPCTransport.sharedDispatcher = new UndiciAgent({
        keepAliveTimeout: 10_000,
        keepAliveMaxTimeout: 15_000,
        connections: 8,
      });
    }
    this._dispatcher = RPCTransport.sharedDispatcher;
  }

  get connectionOptions(): RPCTransportOptions {
    return {
      uniqName: this.uniqName,
      baseUrl: this.baseUrl,
      zmqEndpoint: this.zmqEndpoint,
      rateLimits: this.rateLimiter['config'],
      network: this.network,
      responseTimeout: this.responseTimeout,
    };
  }

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      const health = await this.healthcheck();
      if (!health) {
        throw new Error('Cannot connect to RPC node');
      }

      if (this.zmqEndpoint) {
        await this.initializeZMQ();
      }

      this.isConnected = true;
    }, 'connect');
  }

  async disconnect(): Promise<void> {
    await this.rateLimiter.stop();
    this.cleanupZMQ();
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

  /**
   * ORDER GUARANTEE: results[i] corresponds to heights[i]
   * Missing/failed blocks return null at correct position
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({ method: 'getblockhash', params: [height] }));
      const results = await this.rateLimiter.execute(requests, (calls) => this.batchCall(calls));
      return results.map((hash) => hash || null);
    }, 'getManyBlockHashesByHeights');
  }

  /**
   * ORDER GUARANTEE: results[i] corresponds to hashes[i]
   * Missing/failed items return null at the same index
   */
  async requestHexBlocks(hashes: string[]): Promise<(Buffer | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] }));
      const hexResults = await this.rateLimiter.execute(requests, (calls) => this.batchCall<string>(calls));
      const out: (Buffer | null)[] = new Array(hashes.length);
      for (let i = 0; i < hexResults.length; i++) {
        const hex = hexResults[i];
        out[i] = typeof hex === 'string' ? Buffer.from(hex, 'hex') : null;
      }
      return out;
    }, 'requestHexBlocks');
  }

  /**
   * Core batch RPC with UUID matching for order guarantee
   *
   * Process:
   * 1. Generate unique UUID for each request
   * 2. Send JSON-RPC batch with UUIDs
   * 3. Match responses by UUID (ignore server order)
   * 4. Build result array in original request order
   * 5. Fill missing responses with null
   */
  async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      if (this.username && this.password) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        headers.set('Authorization', `Basic ${auth}`);
      }

      const callsWithIds = calls.map((call) => ({ ...call, id: uuidv4() }));
      const payload = callsWithIds.map((call) => ({
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: call.id,
      }));

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.responseTimeout);

      try {
        const init: UndiciRequestInit = {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: ac.signal,
          dispatcher: this._dispatcher!,
        };

        const response = await fetch(this.baseUrl, init as unknown as RequestInit);
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const raw = await response.json();
        const array = Array.isArray(raw) ? raw : [raw];

        const responseMap = new Map<string, { result?: any; error?: any }>();
        for (const r of array) {
          const id = r?.id;
          if (typeof id === 'string' || typeof id === 'number') {
            if (!responseMap.has(id as any)) responseMap.set(id as any, r);
          }
        }

        return callsWithIds.map((call) => {
          const r = responseMap.get(call.id);
          if (!r || r.error !== null) return null;
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

  subscribeToNewBlocks(
    callback: (blockData: Buffer) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    const sub: BlockSubscriber = { onData: callback, onError };
    this.blockSubscriptions.add(sub);

    if (this.blockSubscriptions.size === 1 && this.zmqEndpoint && !this.zmqRunning) {
      this.initializeZMQ().catch((err) => {
        for (const s of this.blockSubscriptions) s.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }

    return {
      unsubscribe: () => {
        this.blockSubscriptions.delete(sub);
        if (this.blockSubscriptions.size === 0) {
          this.cleanupZMQ();
        }
      },
    };
  }

  private async initializeZMQ(): Promise<void> {
    if (!this.zmqEndpoint || this.zmqRunning) return;

    try {
      this.zmqSocket = new zmq.Subscriber();
      this.zmqSocket.connect(this.zmqEndpoint);
      this.zmqSocket.subscribe('rawblock');
      this.zmqRunning = true;
      this.zmqReconnectAttempts = 0;
      this.processZMQMessages();
    } catch (error) {
      this.zmqSocket = undefined;
      this.zmqRunning = false;
      this.scheduleZMQReconnect(error);
    }
  }

  private async processZMQMessages(): Promise<void> {
    if (!this.zmqSocket) return;

    try {
      for await (const frames of this.zmqSocket) {
        if (!this.zmqRunning) break;

        const arr = Array.isArray(frames) ? frames : [frames];
        const topicFrame = arr[0];
        const topicStr =
          typeof topicFrame === 'string' ? topicFrame : Buffer.isBuffer(topicFrame) ? topicFrame.toString() : '';
        if (topicStr === 'rawblock' && this.blockSubscriptions.size > 0) {
          const blockFrame = arr[arr.length - 1]!;
          const blockBuffer = Buffer.isBuffer(blockFrame) ? blockFrame : Buffer.from(blockFrame);
          for (const s of this.blockSubscriptions) {
            try {
              s.onData(blockBuffer);
            } catch (err) {
              s.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
      }
      if (this.zmqRunning) this.scheduleZMQReconnect(new Error('ZMQ iterator ended'));
    } catch (error) {
      for (const s of this.blockSubscriptions) s.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (this.zmqRunning) this.scheduleZMQReconnect(error);
    }
  }

  private scheduleZMQReconnect(cause: unknown): void {
    this.cleanupZMQ();

    if (!this.zmqEndpoint || this.blockSubscriptions.size === 0) return;

    const attempt = ++this.zmqReconnectAttempts;
    const delay = Math.min(30_000, 500 * Math.pow(2, attempt));

    this.zmqReconnectTimer && clearTimeout(this.zmqReconnectTimer);
    this.zmqReconnectTimer = setTimeout(() => {
      this.initializeZMQ().catch((err) => {
        for (const s of this.blockSubscriptions) s.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, delay);
  }

  /* eslint-disable no-empty */
  private cleanupZMQ(): void {
    this.zmqRunning = false;
    if (this.zmqSocket) {
      try {
        this.zmqSocket.close();
      } catch {}
      this.zmqSocket = undefined;
    }
    if (this.zmqReconnectTimer) {
      clearTimeout(this.zmqReconnectTimer);
      this.zmqReconnectTimer = undefined;
    }
  }
  /* eslint-enable no-empty */
}
