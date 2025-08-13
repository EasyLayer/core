import * as http from 'node:http';
import * as https from 'node:https';
import * as zmq from 'zeromq';
import type { BaseTransportOptions } from './base.transport';
import { BaseTransport } from './base.transport';

export interface RPCTransportOptions extends BaseTransportOptions {
  baseUrl: string;
  responseTimeout?: number;
  zmqEndpoint?: string;
}

/**
 * RPC Transport for Bitcoin-compatible blockchain communication via JSON-RPC
 *
 * Architecture:
 * - HTTP/HTTPS JSON-RPC communication with Bitcoin-compatible nodes (BTC, BCH, DOGE, LTC)
 * - Supports batch requests for optimal performance
 * - ZMQ support for real-time block subscriptions
 * - Built-in connection pooling and timeout handling
 *
 * Performance characteristics:
 * - Batch calls: O(1) network round-trip for multiple operations
 * - Individual calls: O(1) network round-trip per operation
 * - ZMQ subscriptions: Real-time with minimal latency
 */
export class RPCTransport extends BaseTransport<RPCTransportOptions> {
  readonly type = 'RPC';

  private baseUrl: string;
  private username?: string;
  private password?: string;
  private requestId = 1;
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
      await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) => this.batchCall(calls));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get current blockchain height
   * Node calls: 1 (getblockcount)
   * Time complexity: O(1)
   */
  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const results = await this.batchCall([{ method: 'getblockcount', params: [] }]);
      return results[0];
    }, 'getBlockHeight');
  }

  /**
   * Get block hashes by heights using batch RPC calls
   * Node calls: 1 (batch getblockhash for all heights)
   * Time complexity: O(k) where k = number of heights
   * @returns Array preserving order with nulls for missing heights
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({ method: 'getblockhash', params: [height] }));
      const results = await this.batchCall(requests);

      // Results array preserves order from input heights array
      // null values indicate blocks that don't exist at those heights
      return results.map((hash) => hash || null);
    }, 'getManyBlockHashesByHeights');
  }

  /**
   * Request blocks via RPC calls
   * Node calls: 1 (batch getblock for all hashes)
   * Time complexity: O(k) where k = number of blocks requested
   * @returns Array of block buffers in same order as input hashes
   */
  async requestBlocks(hashes: string[]): Promise<Buffer[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] })); // verbosity 0 = hex
      const hexResults = await this.batchCall(requests);

      return hexResults.map((hex: string | null) => {
        if (!hex) {
          throw new Error('Block not found');
        }
        return Buffer.from(hex, 'hex');
      });
    }, 'requestBlocks');
  }

  /**
   * Core batch RPC call method
   * Node calls: 1 (single HTTP request with multiple JSON-RPC calls)
   * Time complexity: O(k) where k = number of calls in batch
   */
  async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<TResult[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      if (this.username && this.password) {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        headers.set('Authorization', `Basic ${auth}`);
      }

      const payload = calls.map((call) => ({
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: this.requestId++,
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

      const results = (await response.json()) as Array<{ result?: any; error?: any }>;

      if (!Array.isArray(results)) {
        throw new Error('Invalid response structure: response data is not an array');
      }

      return results.map((result) => {
        if (result.error) {
          return null; // Preserve order for failed calls
        }
        return result.result;
      });
    }, 'batchCall');
  }

  /**
   * Subscribe to new blocks via ZMQ
   * Node calls: 0 (real-time ZMQ messages)
   * Memory: Stores callback references only, blocks are not cached
   */
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

  /**
   * Initialize ZMQ subscriber for real-time block notifications
   * Memory: Minimal - only ZMQ socket and message handlers
   */
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

  /**
   * Process incoming ZMQ messages and distribute to subscribers
   * Memory: No storage - messages are immediately forwarded to callbacks
   */
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
              // Ignore callback errors to prevent one bad subscriber from affecting others
            }
          });
        }
      }
    } catch (error) {
      // ZMQ connection error - will be handled by reconnection logic
    }
  }

  /**
   * Clean up ZMQ resources
   */
  private cleanupZMQ(): void {
    if (this.zmqSocket && this.zmqRunning) {
      this.zmqRunning = false;
      this.zmqSocket.close();
      this.zmqSocket = undefined;
    }
  }
}
