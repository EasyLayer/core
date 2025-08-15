import * as http from 'node:http';
import * as https from 'node:https';
import * as zmq from 'zeromq';
import { v4 as uuidv4 } from 'uuid';
import type { BaseTransportOptions } from './base.transport';
import { BaseTransport } from './base.transport';

export interface RPCTransportOptions extends BaseTransportOptions {
  baseUrl: string;
  responseTimeout?: number;
  zmqEndpoint?: string;
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
 * Server: [{id:uuid3,result:C}, {id:uuid1,result:A}] // B missing, wrong order
 * Output: [A, null, C] // Correct order, null for missing B
 */
export class RPCTransport extends BaseTransport<RPCTransportOptions> {
  readonly type = 'rpc';

  private baseUrl: string;
  private username?: string;
  private password?: string;
  private responseTimeout: number;
  private _httpClient: any;

  // ZMQ for subscriptions
  private zmqEndpoint?: string;
  private zmqSocket?: zmq.Subscriber;
  private zmqRunning = false;
  private blockSubscriptions = new Set<(blockData: Buffer) => void>();

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

    // Create HTTP agent with connection pooling
    const isHttps = this.baseUrl.startsWith('https://');
    this._httpClient = isHttps
      ? new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 5,
          maxFreeSockets: 2,
          timeout: this.responseTimeout,
        })
      : new http.Agent({
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 5,
          maxFreeSockets: 2,
          timeout: this.responseTimeout,
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

      return hexResults.map((hex: string | null) => {
        if (!hex) {
          throw new Error('Block not found');
        }
        return Buffer.from(hex, 'hex');
      });
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

      const requestOptions: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...(this._httpClient && { agent: this._httpClient }),
      };

      const response = await fetch(this.baseUrl, requestOptions);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! Status: ${response.status}, ${errorText}`);
      }

      const rawResults = (await response.json()) as Array<{ id: string; result?: any; error?: any }>;

      if (!Array.isArray(rawResults)) {
        throw new Error('Invalid response structure: response data is not an array');
      }

      // STEP 3: Create UUID -> response mapping (ignore server order)
      const responseMap = new Map<string, { result?: any; error?: any }>();
      rawResults.forEach((response) => {
        if (response.id !== undefined) {
          responseMap.set(response.id, response);
        }
      });

      // STEP 4: Build results in original request order using UUID matching
      return callsWithIds.map((call) => {
        const response = responseMap.get(call.id);
        if (!response) {
          return null; // Missing response -> null
        }
        if (response.error) {
          return null; // Error response -> null
        }
        return response.result ?? null; // undefined result -> null
      });
    }, 'batchCall');
  }

  subscribeToNewBlocks(callback: (blockData: Buffer) => void): { unsubscribe: () => void } {
    this.blockSubscriptions.add(callback);

    if (this.blockSubscriptions.size === 1 && this.zmqEndpoint && !this.zmqRunning) {
      this.initializeZMQ().catch(() => {
        // ZMQ initialization failed, silently continue
      });
    }

    return {
      unsubscribe: () => {
        this.blockSubscriptions.delete(callback);
        if (this.blockSubscriptions.size === 0) {
          this.cleanupZMQ();
        }
      },
    };
  }

  async disconnect(): Promise<void> {
    await this.rateLimiter.stop();
    this.cleanupZMQ();

    // Force close HTTP connections
    if (this._httpClient && this.baseUrl.startsWith('https://')) {
      const agent = this._httpClient as any;
      if (agent.sockets) {
        Object.values(agent.sockets).forEach((sockets: any) => {
          if (Array.isArray(sockets)) {
            sockets.forEach((socket: any) => socket?.destroy?.());
          }
        });
      }
      if (agent.freeSockets) {
        Object.values(agent.freeSockets).forEach((sockets: any) => {
          if (Array.isArray(sockets)) {
            sockets.forEach((socket: any) => socket?.destroy?.());
          }
        });
      }
    }

    if (this._httpClient) {
      this._httpClient.destroy();
      this._httpClient = null;
    }

    this.isConnected = false;
  }

  private async initializeZMQ(): Promise<void> {
    if (!this.zmqEndpoint || this.zmqRunning) return;

    try {
      this.zmqSocket = new zmq.Subscriber();
      this.zmqSocket.connect(this.zmqEndpoint);
      this.zmqSocket.subscribe('rawblock');
      this.zmqRunning = true;
      this.processZMQMessages();
    } catch (error) {
      this.zmqSocket = undefined;
      this.zmqRunning = false;
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
          this.blockSubscriptions.forEach((callback) => {
            try {
              callback(blockBuffer);
            } catch (error) {
              // Ignore callback errors
            }
          });
        }
      }
    } catch (error) {
      // ZMQ connection error
    }
  }

  private cleanupZMQ(): void {
    if (this.zmqSocket && this.zmqRunning) {
      this.zmqRunning = false;
      this.zmqSocket.close();
      this.zmqSocket = undefined;
    }
  }
}
