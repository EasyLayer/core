import type { BaseTransportOptions, ByteData } from '../../../core';
import { BaseTransport, RateLimiter } from '../../../core';
import { ConnectionError, TimeoutError, RateLimitError } from '../../../core/blockchain-provider/transports/errors';

export interface RPCTransportOptions extends BaseTransportOptions {
  baseUrl: string;
  responseTimeout?: number;
  zmqEndpoint?: string;
  rateLimits?: {
    maxBatchSize?: number;
    maxConcurrentRequests?: number;
    minTimeMsBetweenRequests?: number;
    reservoir?: number;
    reservoirRefreshInterval?: number;
    reservoirRefreshAmount?: number;
  };
}

type BlockSubscriber = {
  onData: (blockData: ByteData) => void;
  onError?: (err: Error) => void;
};

const isNodeLike =
  typeof process !== 'undefined' && typeof (process as any).versions === 'object' && !!(process as any).versions.node;

/**
 * RPC Transport for Bitcoin Core JSON-RPC 2.0
 *
 * Architecture:
 * - Each request gets unique ID for response matching
 * - Batching follows JSON-RPC 2.0 spec: array of individual requests
 * - RateLimiter handles grouping and batching
 * - Order preserved through ID matching
 *
 * Example batch to Bitcoin Core:
 * [
 *   {"jsonrpc": "2.0", "id": 1, "method": "getrawtransaction", "params": ["txid1", false]},
 *   {"jsonrpc": "2.0", "id": 2, "method": "getrawtransaction", "params": ["txid2", false]}
 * ]
 */
export class RPCTransport extends BaseTransport<RPCTransportOptions> {
  readonly type = 'rpc' as const;
  private baseUrl: string;
  private displayUrl: string; // URL without credentials, safe for logging
  private headers: Record<string, string>;
  private responseTimeout: number;
  private zmqEndpoint?: string;

  private rateLimiter: RateLimiter;
  private _id = 1;
  private readonly MAX_ID = 2147483647; // Max safe int32

  // ZMQ subscription handling
  private zmqSocket?: any;
  private zmqRunning = false;
  private blockSubscriptions = new Set<BlockSubscriber>();
  private zmqReconnectAttempts = 0;
  private zmqReconnectTimer?: any;

  constructor(options: RPCTransportOptions) {
    super(options);

    if (!isNodeLike) {
      throw new Error('This RPCTransport requires Node/Electron main. Use a browser polyfill for RPC if needed.');
    }

    // Parse URL and extract credentials
    const url = new URL(options.baseUrl);
    const username = url.username || undefined;
    const password = url.password || undefined;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();
    this.displayUrl = this.baseUrl; // already stripped credentials

    // Setup headers with basic auth if needed
    this.headers = { 'Content-Type': 'application/json' };
    if (username || password) {
      const raw = `${username ?? ''}:${password ?? ''}`;
      this.headers.Authorization = 'Basic ' + Buffer.from(raw).toString('base64');
    }

    this.responseTimeout = options.responseTimeout ?? 5000;
    this.zmqEndpoint = options.zmqEndpoint;

    // Initialize rate limiter with config
    this.rateLimiter = new RateLimiter(options.rateLimits ?? {});
  }

  get connectionOptions(): RPCTransportOptions {
    return {
      uniqName: this.uniqName,
      baseUrl: this.baseUrl,
      zmqEndpoint: this.zmqEndpoint,
      network: this.network,
      responseTimeout: this.responseTimeout,
      rateLimits: this.rateLimiter.getConfig(),
    };
  }

  /**
   * Get next JSON-RPC ID with overflow protection
   */
  private getNextId(): number {
    if (this._id >= this.MAX_ID) this._id = 1;
    return this._id++;
  }

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      // Verify RPC connectivity
      const healthy = await this.healthcheck();
      if (!healthy) {
        throw new TimeoutError({
          message: `RPC node is not responding at ${this.displayUrl}`,
          params: { providerName: this.uniqName, url: this.displayUrl },
        });
      }

      // Initialize ZMQ if configured
      if (isNodeLike && this.zmqEndpoint) {
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
      const [result] = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall(calls)
      );
      return result !== null && result !== undefined;
    } catch {
      return false;
    }
  }

  // ===== Block operations =====

  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const [result] = await this.rateLimiter.execute([{ method: 'getblockcount', params: [] }], (calls) =>
        this.batchCall(calls)
      );
      if (typeof result !== 'number') throw new Error('Invalid getblockcount response');
      return result;
    }, 'getBlockHeight');
  }

  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({
        method: 'getblockhash',
        params: [height],
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<string>(calls));
    }, 'getManyBlockHashesByHeights');
  }

  async requestHexBlocks(hashes: string[]): Promise<(ByteData | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({
        method: 'getblock',
        params: [hash, 0], // 0 = raw hex
      }));
      const hexResults = await this.rateLimiter.execute(requests, (calls) => this.batchCall<string>(calls));
      // Convert hex strings to Buffer
      return hexResults.map((hex) => (typeof hex === 'string' ? Buffer.from(hex, 'hex') : null));
    }, 'requestHexBlocks');
  }

  async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = await this.getBlockHeadersByHashes(hashes);
      return headers.map((header) => (header && typeof header.height === 'number' ? header.height : null));
    }, 'getHeightsByHashes');
  }

  async getRawBlocksByHashesVerbose(hashes: string[], verbosity: 1 | 2): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({
        method: 'getblock',
        params: [hash, verbosity],
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<any>(calls));
    }, 'getRawBlocksByHashesVerbose');
  }

  async getBlockStatsByHashes(hashes: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({
        method: 'getblockstats',
        params: [hash],
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<any>(calls));
    }, 'getBlockStatsByHashes');
  }

  async getBlockHeadersByHashes(hashes: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({
        method: 'getblockheader',
        params: [hash, true], // true = verbose
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<any>(calls));
    }, 'getBlockHeadersByHashes');
  }

  // ===== Transaction operations =====

  async getRawTransactionsHexByTxids(txids: string[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = txids.map((txid) => ({
        method: 'getrawtransaction',
        params: [txid, false], // false = hex string
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<string>(calls));
    }, 'getRawTransactionsHexByTxids');
  }

  async getRawTransactionsByTxids(txids: string[], verbosity: 1 | 2): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = txids.map((txid) => ({
        method: 'getrawtransaction',
        params: [txid, verbosity],
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<any>(calls));
    }, 'getRawTransactionsByTxids');
  }

  // ===== Mempool operations =====

  async getRawMempool(verbose: boolean = false): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [result] = await this.rateLimiter.execute([{ method: 'getrawmempool', params: [verbose] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return result ?? (verbose ? {} : []);
    }, 'getRawMempool');
  }

  async getMempoolVerbose(): Promise<Record<string, any>> {
    const result = await this.getRawMempool(true);
    return result && typeof result === 'object' ? result : {};
  }

  async getMempoolEntries(txids: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const requests = txids.map((txid) => ({
        method: 'getmempoolentry',
        params: [txid],
      }));
      return await this.rateLimiter.execute(requests, (calls) => this.batchCall<any>(calls));
    }, 'getMempoolEntries');
  }

  async getMempoolInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [result] = await this.rateLimiter.execute([{ method: 'getmempoolinfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return result ?? {};
    }, 'getMempoolInfo');
  }

  async estimateSmartFee(
    confTarget: number,
    estimateMode: 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'
  ): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [result] = await this.rateLimiter.execute(
        [{ method: 'estimatesmartfee', params: [confTarget, estimateMode] }],
        (calls) => this.batchCall<any>(calls)
      );
      return result ?? null;
    }, 'estimateSmartFee');
  }

  // ===== Chain info operations =====

  async getBlockchainInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [result] = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return result ?? {};
    }, 'getBlockchainInfo');
  }

  async getNetworkInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [result] = await this.rateLimiter.execute([{ method: 'getnetworkinfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return result ?? {};
    }, 'getNetworkInfo');
  }

  /**
   * Execute JSON-RPC 2.0 batch call.
   * Preserves order through ID matching.
   *
   * Throws typed transport errors (ConnectionError, TimeoutError, RateLimitError) on
   * network/HTTP failures so that isTransportFailure() in blockchain-provider.service.ts
   * can trigger provider failover correctly.
   * Returns null per-item only for item-level RPC errors (unknown txid, etc.).
   */
  private async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
    if (calls.length === 0) return [];

    // Build JSON-RPC 2.0 batch request
    const batch = calls.map((call) => ({
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: call.method,
      params: call.params,
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.responseTimeout);

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
    } catch (error) {
      // Network-level failure: connection refused, DNS, abort (timeout), etc.
      const cause = (error as Error).message ?? String(error);
      const isTimeout = (error as any)?.name === 'AbortError';
      if (isTimeout) {
        throw new TimeoutError({
          message: `RPC timeout after ${this.responseTimeout}ms for provider "${this.uniqName}" at ${this.displayUrl}`,
          params: { providerName: this.uniqName, url: this.displayUrl },
        });
      }
      throw new ConnectionError({
        message: `RPC connection failed for provider "${this.uniqName}" at ${this.displayUrl}: ${cause}`,
        params: { providerName: this.uniqName, url: this.displayUrl },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const statusCode = response.status;
      if (statusCode === 429) {
        throw new RateLimitError({
          message: `RPC rate limit for provider "${this.uniqName}" at ${this.displayUrl}: HTTP ${statusCode}`,
          params: { providerName: this.uniqName, url: this.displayUrl, statusCode },
        });
      }
      throw new ConnectionError({
        message: `RPC HTTP error for provider "${this.uniqName}" at ${this.displayUrl}: ${statusCode} ${response.statusText}`,
        params: { providerName: this.uniqName, url: this.displayUrl, statusCode },
      });
    }

    const results = await response.json();

    // Handle single response (non-batch)
    if (!Array.isArray(results)) {
      return [results.error ? null : results.result ?? null];
    }

    // Map responses by ID
    const responseMap = new Map<number, any>();
    for (const res of results) {
      if (typeof res.id === 'number') {
        responseMap.set(res.id, res);
      }
    }

    // Map back to original order; per-item RPC errors return null (not thrown)
    return batch.map((req) => {
      const res = responseMap.get(req.id);
      if (!res || res.error) return null;
      return res.result ?? null;
    });
  }

  // ===== ZMQ subscription for new blocks =====

  subscribeToNewBlocks(
    callback: (blockData: ByteData) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    if (!this.zmqEndpoint) {
      // Propagate immediately — caller must handle this
      const err = new Error(
        `Provider "${this.uniqName}": zmqEndpoint is not configured, block subscription is not available`
      );
      onError?.(err);
      // Return a no-op unsubscribe so the caller does not crash
      return { unsubscribe: () => {} };
    }

    const subscriber: BlockSubscriber = { onData: callback, onError };
    this.blockSubscriptions.add(subscriber);

    // Start ZMQ if this is the first subscriber
    if (this.blockSubscriptions.size === 1 && !this.zmqRunning) {
      this.initializeZMQ().catch((err) => {
        const wrapped = new Error(
          `Provider "${this.uniqName}": ZMQ initialization failed at ${this.zmqEndpoint}: ${(err as Error).message}`
        );
        for (const sub of this.blockSubscriptions) {
          sub.onError?.(wrapped);
        }
      });
    }

    return {
      unsubscribe: () => {
        this.blockSubscriptions.delete(subscriber);
        if (this.blockSubscriptions.size === 0) {
          this.cleanupZMQ();
        }
      },
    };
  }

  private async initializeZMQ(): Promise<void> {
    try {
      const zmq = await import('zeromq');
      const { Subscriber } = zmq as any;

      this.zmqSocket = new Subscriber();
      this.zmqSocket.connect(this.zmqEndpoint);
      this.zmqSocket.subscribe('rawblock');
      this.zmqRunning = true;
      // Reset reconnect counter on successful init so future disconnects
      // start exponential backoff from the beginning, not from the last failure count.
      this.zmqReconnectAttempts = 0;

      // Start processing messages.
      // On error: scheduleZMQReconnect is the single entry point that notifies subscribers
      // and schedules retry. Do NOT notify subscribers here — that is scheduleZMQReconnect's job.
      this.processZMQMessages().catch((err) => {
        if (this.zmqRunning) {
          this.scheduleZMQReconnect(err);
        }
      });
    } catch (error) {
      this.scheduleZMQReconnect(error);
      throw error;
    }
  }

  private async processZMQMessages(): Promise<void> {
    if (!this.zmqSocket) return;

    for await (const [topic, message] of this.zmqSocket) {
      if (!this.zmqRunning) break;

      const topicStr = typeof topic === 'string' ? topic : topic?.toString?.();
      if (topicStr === 'rawblock') {
        // Distribute to all subscribers
        for (const sub of this.blockSubscriptions) {
          sub.onData(message as Buffer);
        }
      }
    }
  }

  private scheduleZMQReconnect(_cause: unknown): void {
    this.cleanupZMQ();
    if (!this.zmqEndpoint) return;

    // Notify all subscribers about the disconnect BEFORE scheduling reconnect.
    // The strategy (SubscribeBlockStrategy) will catch the error, reject its Promise,
    // and the loader supervisor will restart it — performing performInitialCatchup()
    // to recover any blocks missed during the reconnection window.
    const disconnectErr = new Error(
      `Provider "${this.uniqName}": ZMQ connection lost at ${this.zmqEndpoint}, reconnecting...`
    );
    for (const sub of this.blockSubscriptions) {
      sub.onError?.(disconnectErr);
    }
    // Clear subscriptions — callers will re-subscribe after strategy restarts
    this.blockSubscriptions.clear();

    const attempt = ++this.zmqReconnectAttempts;
    const delay = Math.min(30_000, 500 * Math.pow(2, attempt));

    if (this.zmqReconnectTimer) {
      clearTimeout(this.zmqReconnectTimer);
    }

    this.zmqReconnectTimer = setTimeout(() => {
      this.initializeZMQ().catch((err) => {
        const wrapped = new Error(
          `Provider "${this.uniqName}": ZMQ reconnect attempt ${attempt} failed at ${this.zmqEndpoint}: ${(err as Error).message}`
        );
        for (const sub of this.blockSubscriptions) {
          sub.onError?.(wrapped);
        }
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
