import { Agent as UndiciAgent, fetch } from 'undici';
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
 * Server: [{id:uuid3,result:C}, {id:uuid1,result:A}] // B missing, wrong order
 * Output: [A, null, C] // Correct order, null for missing B
 */
export class RPCTransport extends BaseTransport<RPCTransportOptions> {
  readonly type = 'rpc';

  private baseUrl: string;
  private username?: string;
  private password?: string;
  private responseTimeout: number;

  // Undici HTTP client dispatcher
  private _dispatcher?: UndiciAgent;

  // ZMQ for subscriptions with reconnect
  private zmqEndpoint?: string;
  private zmqSocket?: zmq.Subscriber;
  private zmqRunning = false;
  private blockSubscriptions = new Set<BlockSubscriber>();

  // Reconnect backoff
  private zmqReconnectAttempts = 0;
  private zmqReconnectTimer?: NodeJS.Timeout;

  constructor(options: RPCTransportOptions) {
    super(options);

    // Parse URL for auth
    const url = new URL(options.baseUrl);
    this.username = url.username || undefined;
    this.password = url.password || undefined;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();

    this.responseTimeout = options.responseTimeout ?? 5000;
    this.zmqEndpoint = options.zmqEndpoint;

    // Undici agent for keep-alive connection pooling
    this._dispatcher = new UndiciAgent({
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 15_000,
      connections: 8,
    });
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

  async healthcheck(): Promise<boolean> {
    try {
      const results = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall(calls)
      );

      // Check if we got a valid response
      return results[0] !== null && results[0] !== undefined;
    } catch (error) {
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

      // RateLimiter + batchCall maintain order via UUID matching
      const results = await this.rateLimiter.execute(requests, (calls) => this.batchCall(calls));

      // Ensure null conversion for failed requests
      return results.map((hash) => hash || null);
    }, 'getManyBlockHashesByHeights');
  }

  /**
   * ORDER GUARANTEE: results[i] corresponds to hashes[i]
   * Throws error if any block is missing (no null tolerance)
   */
  async requestHexBlocks(hashes: string[]): Promise<Buffer[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] }));

      // RateLimiter + batchCall maintain order via UUID matching
      const hexResults = await this.rateLimiter.execute(requests, (calls) => this.batchCall(calls));

      const out: Buffer[] = new Array(hashes.length);
      for (let i = 0; i < hexResults.length; i++) {
        const hex = hexResults[i];
        if (!hex) {
          // keep a hole for the caller to map to null later or throw here if strict is needed
          throw new Error(`Block not found for hash ${hashes[i]} at position ${i}`);
        }
        out[i] = Buffer.from(hex, 'hex');
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

      // STEP 1: Generate unique UUID for each request
      const callsWithIds = calls.map((call) => ({
        ...call,
        id: uuidv4(),
      }));

      // STEP 2: Create JSON-RPC payload with UUIDs
      const payload = callsWithIds.map((call) => ({
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: call.id,
      }));

      // Proper timeout via AbortController; use Undici dispatcher
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.responseTimeout);

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        dispatcher: this._dispatcher, // <— Undici agent
        signal: ac.signal, // <— real timeout
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP error! Status: ${response.status}, ${errorText}`);
      }

      const rawResults = (await response.json()) as Array<{ id: string; result?: any; error?: any }>;
      if (!Array.isArray(rawResults)) throw new Error('Invalid response structure: response data is not an array');

      const responseMap = new Map<string, { result?: any; error?: any }>();
      rawResults.forEach((r) => {
        if (r.id !== undefined) responseMap.set(r.id, r);
      });

      return callsWithIds.map((call) => {
        const r = responseMap.get(call.id);
        if (!r) return null;
        if (r.error) return null;
        return (r.result ?? null) as TResult | null;
      });
    }, 'batchCall');
  }

  // Multiple-subscriber API with error propagation
  subscribeToNewBlocks(
    callback: (blockData: Buffer) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    const sub: BlockSubscriber = { onData: callback, onError };
    this.blockSubscriptions.add(sub);

    if (this.blockSubscriptions.size === 1 && this.zmqEndpoint && !this.zmqRunning) {
      this.initializeZMQ().catch((err) => {
        // notify subscribers about init error
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

  async disconnect(): Promise<void> {
    await this.rateLimiter.stop();
    this.cleanupZMQ();

    // Close Undici dispatcher
    await this._dispatcher?.close();
    this._dispatcher = undefined;

    this.isConnected = false;
  }

  // ===== ZMQ with reconnect/backoff =====
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
      for await (const [topic, message] of this.zmqSocket) {
        if (!this.zmqRunning) break;

        const topicStr = topic?.toString();
        if (topicStr === 'rawblock' && this.blockSubscriptions.size > 0) {
          const blockBuffer = message as Buffer;
          for (const s of this.blockSubscriptions) {
            try {
              s.onData(blockBuffer);
            } catch (err) {
              // propagate subscriber error
              s.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
      }
      // loop ended unexpectedly -> reconnect
      if (this.zmqRunning) this.scheduleZMQReconnect(new Error('ZMQ loop ended'));
    } catch (error) {
      // connection error -> notify and reconnect
      for (const s of this.blockSubscriptions) s.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (this.zmqRunning) this.scheduleZMQReconnect(error);
    }
  }

  private scheduleZMQReconnect(cause: unknown): void {
    this.cleanupZMQ();

    if (!this.zmqEndpoint || this.blockSubscriptions.size === 0) return;

    const attempt = ++this.zmqReconnectAttempts;
    const delay = Math.min(30_000, 500 * Math.pow(2, attempt)); // exponential backoff up to 30s

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
