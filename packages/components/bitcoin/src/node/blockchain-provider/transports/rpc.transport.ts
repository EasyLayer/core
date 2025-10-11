import type { BaseTransportOptions } from '../../../core';
import { BaseTransport, RateLimiter } from '../../../core';

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

type Bytes = Buffer | Uint8Array;

type BlockSubscriber = {
  onData: (blockData: Bytes) => void;
  onError?: (err: Error) => void;
};

const isNodeLike =
  typeof process !== 'undefined' && typeof (process as any).versions === 'object' && !!(process as any).versions.node;

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
  private headers: Record<string, string>;
  private responseTimeout: number;
  private zmqEndpoint?: string;

  private rateLimiter: RateLimiter;
  private _id = 1;

  // ZMQ
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

    const url = new URL(options.baseUrl);
    const username = url.username || undefined;
    const password = url.password || undefined;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();

    this.headers = { 'Content-Type': 'application/json' };
    if (username || password) {
      const raw = `${username ?? ''}:${password ?? ''}`;
      this.headers.Authorization =
        typeof Buffer !== 'undefined' ? 'Basic ' + Buffer.from(raw).toString('base64') : 'Basic ' + btoa(raw);
    }

    this.responseTimeout = options.responseTimeout ?? 5000;
    this.zmqEndpoint = options.zmqEndpoint;

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

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      // Try a lightweight call to verify connectivity
      await this.healthcheck();
      // Initialize ZMQ after successful healthcheck if configured
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
      const [r] = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall(calls)
      );
      return r !== null && r !== undefined;
    } catch {
      return false;
    }
  }

  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getblockcount', params: [] }], (calls) =>
        this.batchCall(calls)
      );
      if (typeof r !== 'number') throw new Error('Invalid getblockcount response');
      return r;
    }, 'getBlockHeight');
  }

  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = heights.map((h) => ({ method: 'getblockhash', params: [h] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall(calls));
      return results as (string | null)[];
    }, 'getManyBlockHashesByHeights');
  }

  public async requestHexBlocks(hashes: string[]): Promise<(Buffer | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] })); // raw hex
      const hexResults = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<string>(calls));
      return hexResults.map((hex) => (typeof hex === 'string' ? Buffer.from(hex, 'hex') : null));
    }, 'requestHexBlocks');
  }

  // ===== NEW: heights by hashes via headers =====
  async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = await this.getBlockHeadersByHashes(hashes);
      return headers.map((hdr) => (hdr && typeof hdr.height === 'number' ? hdr.height : null));
    }, 'getHeightsByHashes');
  }

  // ===== NEW: verbose blocks (RPC) =====
  async getRawBlocksByHashesVerbose(hashes: string[], verbosity: 1 | 2): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblock', params: [hash, verbosity] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
      return results;
    }, 'getRawBlocksByHashesVerbose');
  }

  // ===== NEW: block stats by hashes (RPC) =====
  async getBlockStatsByHashes(hashes: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblockstats', params: [hash] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
      return results;
    }, 'getBlockStatsByHashes');
  }

  // ===== NEW: block headers by hashes (RPC) =====
  async getBlockHeadersByHashes(hashes: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblockheader', params: [hash, true] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
      return results;
    }, 'getBlockHeadersByHashes');
  }

  // ===== Transactions =====
  async getRawTransactionsHexByTxids(txids: string[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = txids.map((txid) => ({ method: 'getrawtransaction', params: [txid, false] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<string>(calls));
      return results;
    }, 'getRawTransactionsHexByTxids');
  }

  async getRawTransactionsByTxids(txids: string[], verbosity: 1 | 2): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = txids.map((txid) => ({ method: 'getrawtransaction', params: [txid, verbosity] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
      return results;
    }, 'getRawTransactionsByTxids');
  }

  // ===== Mempool / fees =====
  async getRawMempool(verbose: boolean = false): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getrawmempool', params: [verbose] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? (verbose ? {} : []);
    }, 'getRawMempool');
  }

  async getMempoolVerbose(): Promise<Record<string, any>> {
    const out = await this.getRawMempool(true);
    return out && typeof out === 'object' ? (out as Record<string, any>) : {};
  }

  async getMempoolEntries(txids: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = txids.map((txid) => ({ method: 'getmempoolentry', params: [txid] }));
      const results = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
      return results;
    }, 'getMempoolEntries');
  }

  async getMempoolInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getmempoolinfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? {};
    }, 'getMempoolInfo');
  }

  async estimateSmartFee(
    confTarget: number,
    estimateMode: 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'
  ): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute(
        [{ method: 'estimatesmartfee', params: [confTarget, estimateMode] }],
        (calls) => this.batchCall<any>(calls)
      );
      return r ?? null;
    }, 'estimateSmartFee');
  }

  // ===== Chain info =====
  async getBlockchainInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? {};
    }, 'getBlockchainInfo');
  }

  async getNetworkInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getnetworkinfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? {};
    }, 'getNetworkInfo');
  }

  // ===== Private JSON-RPC batch executor (order-preserving, null-safe) =====
  private async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const callsWithIds = calls.map((c) => ({ id: this._id++, jsonrpc: '2.0', ...c }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.responseTimeout);
      try {
        const res = await fetch(this.baseUrl, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(callsWithIds),
          signal: controller.signal,
        });

        if (!res.ok) {
          // Preserve array shape with nulls if transport fails
          return new Array(calls.length).fill(null);
        }

        const array = (await res.json()) as Array<{ id: number | string; result?: any; error?: any }>;
        const responseMap = new Map<string | number, { result?: any; error?: any }>();
        for (const r of array) {
          const id = (r as any)?.id;
          if (typeof id === 'string' || typeof id === 'number') {
            if (!responseMap.has(id)) responseMap.set(id, r);
          }
        }

        return callsWithIds.map((call) => {
          const r = responseMap.get(call.id as string | number);
          if (!r || r.error != null) return null;
          return (r.result ?? null) as TResult | null;
        });
      } finally {
        clearTimeout(timer);
      }
    }, 'batchCall');
  }

  // ===== ZMQ subscribe to raw blocks (Node only) =====
  public subscribeToNewBlocks(
    callback: (blockData: Buffer | Uint8Array) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    const sub: BlockSubscriber = { onData: (b) => callback(b), onError };
    this.blockSubscriptions.add(sub);

    if (this.blockSubscriptions.size === 1 && this.zmqEndpoint && !this.zmqRunning) {
      this.initializeZMQ().catch((err) => {
        for (const s of this.blockSubscriptions) s.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }

    return {
      unsubscribe: () => {
        this.blockSubscriptions.delete(sub);
        if (this.blockSubscriptions.size === 0) this.cleanupZMQ();
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

      // Fire-and-forget async loop
      this.processZMQMessages().catch((err) => {
        for (const s of this.blockSubscriptions) s.onError?.(err instanceof Error ? err : new Error(String(err)));
        if (this.zmqRunning) this.scheduleZMQReconnect(err);
      });
    } catch (error) {
      this.scheduleZMQReconnect(error);
      throw error;
    }
  }

  private async processZMQMessages(): Promise<void> {
    if (!this.zmqSocket) return;
    for await (const [topic, msg] of this.zmqSocket) {
      if (!this.zmqRunning) break;
      const t = typeof topic === 'string' ? topic : topic?.toString?.();
      if (t === 'rawblock') {
        for (const s of this.blockSubscriptions) s.onData(msg as Buffer);
      }
    }
  }

  private scheduleZMQReconnect(_cause: unknown): void {
    this.cleanupZMQ();
    if (!this.zmqEndpoint) return;

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
