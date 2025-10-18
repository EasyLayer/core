import { Buffer } from 'buffer';
import { v4 as uuidv4 } from 'uuid';
import type { BaseTransportOptions, RateLimits } from '../../../core';
import { BaseTransport, RateLimiter } from '../../../core';

export interface RPCTransportOptions extends BaseTransportOptions {
  baseUrl: string;
  responseTimeout?: number;
  /** Optional rate limits specific to this RPC transport (browser). */
  rateLimits?: RateLimits;
}

/** Base64 helper safe for both Node and browser. */
function toBase64(str: string): string {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(str).toString('base64');
  }
  if (typeof btoa !== 'undefined') return btoa(str);
  // @ts-ignore
  return globalThis?.btoa?.(str) ?? '';
}

/** UUID helper with graceful fallback. */
function uuid(): string {
  try {
    return uuidv4();
  } catch {
    // @ts-ignore
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
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
    out[i] = Number('0x' + clean.substr(i * 2, 2));
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
 * Browser RPC Transport (fetch-based) with order-preserving batch JSON-RPC and RateLimiter.
 *
 * Design rules:
 * - RateLimiter lives inside this transport (RPC-only concern).
 * - Public methods map to canonical transport API and call a private batch executor via limiter.
 * - Arrays: results keep exact input order; failures are `null` in-place.
 * - Error handling goes through BaseTransport.executeWithErrorHandling/handleError.
 * - Subscriptions are NOT supported in browser RPC transport (use P2P or Node RPC+ZMQ).
 */
export class RPCTransport extends BaseTransport<RPCTransportOptions> {
  readonly type = 'rpc';

  private baseUrl: string;
  private username?: string;
  private password?: string;
  private responseTimeout: number;

  // Rate limiter is internal to the RPC transport
  private rateLimiter: RateLimiter;

  constructor(options: RPCTransportOptions) {
    super(options);

    // Allow basic auth in URL but strip it out for fetch requests
    const url = new URL(options.baseUrl);
    this.username = url.username || undefined;
    this.password = url.password || undefined;
    url.username = '';
    url.password = '';
    this.baseUrl = url.toString();

    this.responseTimeout = options.responseTimeout ?? 5000;

    // Initialize limiter with provided config (or defaults)
    this.rateLimiter = new RateLimiter(options.rateLimits ?? {});
  }

  get connectionOptions(): RPCTransportOptions {
    return {
      uniqName: this.uniqName,
      baseUrl: this.baseUrl,
      // Expose limiter config for diagnostics (without changing RateLimiter API)

      rateLimits:
        (this.rateLimiter as any)?.getConfig?.() ?? (this.rateLimiter as unknown as { config?: RateLimits })?.config,
      network: this.network,
      responseTimeout: this.responseTimeout,
    } as RPCTransportOptions;
  }

  // ===== Lifecycle =====

  async connect(): Promise<void> {
    return this.executeWithErrorHandling(async () => {
      const ok = await this.healthcheck();
      if (!ok) throw new Error('Cannot connect to RPC node');
      this.isConnected = true;
    }, 'connect');
  }

  async disconnect(): Promise<void> {
    // Stop limiter timers/queues if any
    await this.rateLimiter.stop();
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

  // ===== Canonical API (order-preserving, null-safe) =====

  /** Current best height. */
  async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const [height] = await this.rateLimiter.execute([{ method: 'getblockcount', params: [] }], (calls) =>
        this.batchCall<number>(calls)
      );
      if (typeof height !== 'number') throw new Error('Failed to get block height: invalid response');
      return height;
    }, 'getBlockHeight');
  }

  /** Heights → hashes (aligned with input; null for missing). */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = heights.map((h) => ({ method: 'getblockhash', params: [h] }));
      const res = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<string>(calls));
      return res.map((hash) => (typeof hash === 'string' ? hash : null));
    }, 'getManyBlockHashesByHeights');
  }

  /** Hashes → block bytes (Buffer/Uint8Array), aligned with input. */
  async requestHexBlocks(hashes: string[]): Promise<(Buffer | Uint8Array | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblock', params: [hash, 0] })); // verbosity=0 -> hex
      const hexResults = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<string>(calls));

      const out: (Buffer | Uint8Array | null)[] = new Array(hashes.length);
      for (let i = 0; i < hexResults.length; i++) {
        const hex = hexResults[i];
        if (typeof hex !== 'string') {
          out[i] = null;
          continue;
        }
        out[i] = hasNodeBuffer() ? Buffer.from(hex, 'hex') : hexToU8(hex);
      }
      return out;
    }, 'requestHexBlocks');
  }

  /** Hashes → verbose blocks (JSON), aligned with input. */
  async getRawBlocksByHashesVerbose(hashes: string[], verbosity: 1 | 2 = 1): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblock', params: [hash, verbosity] }));
      return this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
    }, 'getRawBlocksByHashesVerbose');
  }

  /** Hashes → getblockstats results (JSON), aligned with input. */
  async getBlockStatsByHashes(hashes: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblockstats', params: [hash] }));
      return this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
    }, 'getBlockStatsByHashes');
  }

  /** Hashes → headers (JSON), aligned with input. */
  async getBlockHeadersByHashes(hashes: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = hashes.map((hash) => ({ method: 'getblockheader', params: [hash, true] }));
      return this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
    }, 'getBlockHeadersByHashes');
  }

  /** Hashes → heights (via headers), aligned with input. */
  async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = await this.getBlockHeadersByHashes(hashes);
      return headers.map((h) => (h && typeof h.height === 'number' ? h.height : null));
    }, 'getHeightsByHashes');
  }

  /** Txids → tx hex (aligned with input). */
  async getRawTransactionsHexByTxids(txids: string[]): Promise<(string | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = txids.map((txid) => ({ method: 'getrawtransaction', params: [txid, false] }));
      const res = await this.rateLimiter.execute(reqs, (calls) => this.batchCall<string>(calls));
      return res.map((hex) => (typeof hex === 'string' ? hex : null));
    }, 'getRawTransactionsHexByTxids');
  }

  /** Txids → tx verbose JSON (aligned with input). */
  async getRawTransactionsByTxids(txids: string[], verbosity: 1 | 2): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = txids.map((txid) => ({ method: 'getrawtransaction', params: [txid, verbosity] }));
      return this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
    }, 'getRawTransactionsByTxids');
  }

  /** Raw mempool: array (verbose=false) or object map (verbose=true). */
  async getRawMempool(verbose: boolean = false): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getrawmempool', params: [verbose] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? (verbose ? {} : []);
    }, 'getRawMempool');
  }

  /** Convenience: always return object map for verbose mempool. */
  async getMempoolVerbose(): Promise<Record<string, any>> {
    const out = await this.getRawMempool(true);
    return out && typeof out === 'object' ? (out as Record<string, any>) : {};
  }

  /** Txids → mempoolentry JSON (aligned with input). */
  async getMempoolEntries(txids: string[]): Promise<(any | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const reqs = txids.map((txid) => ({ method: 'getmempoolentry', params: [txid] }));
      return this.rateLimiter.execute(reqs, (calls) => this.batchCall<any>(calls));
    }, 'getMempoolEntries');
  }

  /** Mempool info JSON. */
  async getMempoolInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getmempoolinfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? {};
    }, 'getMempoolInfo');
  }

  /** Fee estimate JSON. */
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

  /** Blockchain info JSON. */
  async getBlockchainInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getblockchaininfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? {};
    }, 'getBlockchainInfo');
  }

  /** Network info JSON. */
  async getNetworkInfo(): Promise<any> {
    return this.executeWithErrorHandling(async () => {
      const [r] = await this.rateLimiter.execute([{ method: 'getnetworkinfo', params: [] }], (calls) =>
        this.batchCall<any>(calls)
      );
      return r ?? {};
    }, 'getNetworkInfo');
  }

  // ===== Private JSON-RPC batch executor (order-preserving, null-safe) =====

  /**
   * Execute a batch JSON-RPC call via fetch.
   * - Preserves order using id→result mapping.
   * - Any missing/error responses become null at their original positions.
   * - Times out using AbortController and responseTimeout.
   * NOTE: This is private; providers never call it directly.
   */
  private async batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]> {
    return this.executeWithErrorHandling(async () => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');

      if (this.username && this.password) {
        const auth = toBase64(`${this.username}:${this.password}`);
        headers.set('Authorization', `Basic ${auth}`);
      }

      const callsWithIds = calls.map((call) => ({ ...call, id: uuid() }));
      const payload = callsWithIds.map((c) => ({
        jsonrpc: '2.0',
        method: c.method,
        params: c.params,
        id: c.id,
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

  // ===== Streaming/subscriptions =====

  /**
   * Browser fetch-based RPC does not support subscriptions.
   * Use Node RPC (ZMQ) or P2P transport for streaming new blocks.
   */
  subscribeToNewBlocks(): { unsubscribe: () => void } {
    this.throwNotImplemented('subscribeToNewBlocks');
  }
}
