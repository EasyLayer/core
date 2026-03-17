import type { BaseTransportOptions, ByteData } from '../../../core';
import { BaseTransport, RateLimiter } from '../../../core';

/**
 * Options for MempoolSpaceTransport (Esplora-compatible).
 */
export interface MempoolSpaceTransportOptions extends BaseTransportOptions {
  uniqName: string;
  /** Base Esplora URL, e.g. https://mempool.space/api (no trailing slash) */
  baseUrl: string;
  /** Per-request timeout (ms) */
  responseTimeoutMs?: number;
  /** Rate limiter config */
  rateLimits?: {
    maxBatchSize?: number;
    maxConcurrentRequests?: number;
    minTimeMsBetweenRequests?: number;
    reservoir?: number;
    reservoirRefreshInterval?: number;
    reservoirRefreshAmount?: number;
  };
}

/**
 * MempoolSpaceTransport
 *
 * Key rule: EVERY request (even WS-triggered) goes through RateLimiter.
 * We do not rely on Esplora "batch" APIs; we simply queue/pace via limiter.
 * Order is preserved by RateLimiter (maps results back to original positions).
 */
export class MempoolSpaceTransport extends BaseTransport<MempoolSpaceTransportOptions> {
  public readonly type = 'mempool.space' as const;

  private readonly _options: MempoolSpaceTransportOptions;
  private baseUrl: string;
  private timeout: number;
  private limiter: RateLimiter;

  constructor(options: MempoolSpaceTransportOptions & Record<string, unknown>) {
    super(options);
    this._options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeout = options.responseTimeoutMs ?? 20_000;
    this.limiter = new RateLimiter(options.rateLimits);
  }

  public get connectionOptions(): MempoolSpaceTransportOptions {
    return this._options;
  }

  async connect(): Promise<void> {
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    await this.limiter.stop();
    this.isConnected = false;
  }

  async healthcheck(): Promise<boolean> {
    try {
      const j = await this.fetchJson('/v1/fees/recommended');
      return !!j;
    } catch {
      return false;
    }
  }

  // ========= Low-level HTTP helpers (ALL through RateLimiter) =========

  private buildUrl(path: string) {
    if (path.startsWith('http')) return path;
    if (!path.startsWith('/')) path = '/' + path;
    return this.baseUrl + path;
  }

  /** Single-JSON GET via limiter; returns parsed JSON or throws on HTTP error. */
  private async fetchJson(path: string): Promise<any> {
    const [res] = await this.limiter.execute([{ method: path, params: [] as any[] }], async (batch) => {
      // sequential, index-aligned (no Promise.all)
      const out: (any | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        const url = this.buildUrl(batch[i]!.method);
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), this.timeout);
        try {
          const r = await fetch(url, { signal: ctl.signal });
          if (r.status === 429) throw new Error('429 Too Many Requests');
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
          out[i] = await r.json();
        } finally {
          clearTimeout(t);
        }
      }
      return out;
    });
    return res;
  }

  /** Single-TEXT GET via limiter. */
  private async fetchText(path: string): Promise<string> {
    const [res] = await this.limiter.execute([{ method: path, params: [] as any[] }], async (batch) => {
      const out: (string | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        const url = this.buildUrl(batch[i]!.method);
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), this.timeout);
        try {
          const r = await fetch(url, { signal: ctl.signal });
          if (r.status === 429) throw new Error('429 Too Many Requests');
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
          out[i] = await r.text();
        } finally {
          clearTimeout(t);
        }
      }
      return out;
    });
    return typeof res === 'string' ? res : String(res ?? '');
  }

  /** Single-BINARY GET via limiter. */
  private async fetchBinary(path: string): Promise<Uint8Array> {
    const [res] = await this.limiter.execute([{ method: path, params: [] as any[] }], async (batch) => {
      const out: (Uint8Array | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        const url = this.buildUrl(batch[i]!.method);
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), this.timeout);
        try {
          const r = await fetch(url, { signal: ctl.signal });
          if (r.status === 429) throw new Error('429 Too Many Requests');
          if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
          out[i] = new Uint8Array(await r.arrayBuffer());
        } finally {
          clearTimeout(t);
        }
      }
      return out;
    });
    if (!(res instanceof Uint8Array)) throw new Error('Invalid binary response');
    return res;
  }

  /**
   * Fetches blocks metadata in descending order using Esplora pages:
   * GET /blocks/:start_height returns up to 10 blocks: [start_height .. start_height-9].
   * Continues until endHeight is reached or no data.
   *
   * Returns a Map<height, hash>.
   */
  private async fetchBlocksRangeViaPages(startHeight: number, endHeight: number): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    let cursor = startHeight;
    while (cursor >= endHeight) {
      // One page (up to 10 blocks) – goes through RateLimiter via fetchJson
      const page = await this.fetchJson(`/blocks/${cursor}`);
      if (!Array.isArray(page) || page.length === 0) break;

      for (const b of page) {
        const h: number | undefined = typeof b?.height === 'number' ? b.height : undefined;
        const hash: string | undefined =
          (typeof b?.id === 'string' ? b.id : undefined) ?? (typeof b?.hash === 'string' ? b.hash : undefined);
        if (h != null && typeof hash === 'string') {
          if (h < endHeight) continue;
          map.set(h, hash);
        }
      }

      const last = page[page.length - 1];
      const lastHeight: number | undefined = typeof last?.height === 'number' ? last.height : undefined;
      if (lastHeight == null || lastHeight <= endHeight) break;
      cursor = lastHeight - 1;
    }
    return map;
  }

  // ================= WebSocket subscribe (each hash → limiter) =================

  /**
   * WS emits block hashes; for each, we GET `/block/:hash/raw` through the limiter.
   * No custom batching here: the RateLimiter itself serializes/paces requests.
   */
  /* eslint-disable no-empty */
  subscribeToNewBlocks(
    onBlockBytes: (blockBytes: Uint8Array) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void } {
    const endpoint = this.baseUrl.replace(/^http/, 'ws') + '/v1/ws';
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectAttempts = 0;

    const reopen = () => {
      if (closed) return;
      const delay = Math.min(15_000, 750 * Math.pow(1.6, reconnectAttempts++)) + Math.floor(Math.random() * 500);
      setTimeout(open, delay);
    };

    const open = () => {
      try {
        const WS: any = (globalThis as any).WebSocket;
        if (typeof WS !== 'function') throw new Error('Global WebSocket is not available in this runtime.');
        const socket: WebSocket = new WS(endpoint);
        ws = socket;

        socket.onopen = () => {
          reconnectAttempts = 0;
          try {
            ws?.send(JSON.stringify({ action: 'want', data: ['blocks'] }));
          } catch {}
        };

        socket.onmessage = async (ev: any) => {
          try {
            const payload = typeof ev?.data === 'string' ? JSON.parse(ev.data) : ev?.data;
            const hash =
              payload?.block?.hash ??
              payload?.hash ??
              (Array.isArray(payload?.blocks) && payload.blocks[0]?.hash) ??
              undefined;

            if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) {
              try {
                const bytes = await this.fetchBinary(`/block/${hash}/raw`); // queued via limiter
                if (!(bytes instanceof Uint8Array) || bytes.length < 80) throw new Error('Invalid raw block bytes');
                onBlockBytes(bytes);
              } catch (e) {
                onError?.(e instanceof Error ? e : new Error(String(e)));
              }
            }
          } catch (e) {
            onError?.(e instanceof Error ? e : new Error(String(e)));
          }
        };

        socket.onerror = (e: any) => {
          onError?.(new Error(e?.message ?? 'WebSocket error'));
        };

        socket.onclose = () => {
          if (!closed) reopen();
        };
      } catch (e) {
        onError?.(e as Error);
        reopen();
      }
    };

    open();

    return {
      unsubscribe: () => {
        closed = true;
        const s = ws;
        ws = null;
        try {
          s?.close();
        } catch {}
      },
    };
  }
  /* eslint-enable no-empty */
  // ================= Transactions =================

  async getRawTransactionsByTxids(txids: string[], verbosity: 1 | 2 = 2): Promise<(any | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    if (verbosity === 1) {
      const hexes = await this.getRawTransactionsHexByTxids(txids);
      return hexes.map((h) => (typeof h === 'string' ? h : null));
    }

    const reqs = txids.map((txid) => ({ method: `/tx/${txid}`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const out: (any | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          out[i] = await this.fetchJson(batch[i]!.method);
        } catch {
          out[i] = null;
        }
      }
      return out;
    });
    return rows;
  }

  async getRawTransactionsHexByTxids(txids: string[]): Promise<(string | null)[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const reqs = txids.map((txid) => ({ method: `/tx/${txid}/hex`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const out: (string | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          const s = await this.fetchText(batch[i]!.method);
          out[i] = typeof s === 'string' ? s.trim() : null;
        } catch {
          out[i] = null;
        }
      }
      return out;
    });
    return rows;
  }

  // ================= Mempool endpoints =================

  async getMempoolInfo(): Promise<any> {
    return this.fetchJson('/mempool');
  }

  async getMempoolEntries(txids: string[]): Promise<any[]> {
    if (!Array.isArray(txids) || txids.length === 0) return [];
    const reqs = txids.map((txid) => ({ method: `/tx/${txid}`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const out: (any | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          const tx = await this.fetchJson(batch[i]!.method);
          const feeSats: number = tx?.fee ?? 0;
          const vsize: number = tx?.vsize ?? tx?.size ?? 0;
          const weight: number = tx?.weight ?? (vsize ? vsize * 4 : 0);
          const time: number | undefined = tx?.status?.block_time ?? tx?.received ?? undefined;
          out[i] = {
            fees: { base: feeSats / 1e8 },
            vsize,
            weight,
            time,
            descendantcount: 0,
            ancestorcount: 0,
            depends: [] as string[],
          };
        } catch {
          out[i] = null;
        }
      }
      return out;
    });
    return rows;
  }

  async getRawMempool(verbose: true): Promise<Record<string, any>>;
  async getRawMempool(verbose?: false): Promise<string[]>;
  async getRawMempool(verbose?: boolean): Promise<any> {
    if (verbose === true) {
      return this.getMempoolVerbose();
    }
    const list = await this.fetchJson('/mempool/txids');
    return Array.isArray(list) ? list : [];
  }

  async getMempoolVerbose(): Promise<Record<string, any>> {
    const txids = await this.getRawMempool(false);
    if (txids.length === 0) return {};
    const entries = await this.getMempoolEntries(txids);
    const out: Record<string, any> = {};
    for (let i = 0; i < txids.length; i++) {
      const e = entries[i];
      if (e) out[txids[i]!] = e;
    }
    return out;
  }

  async estimateSmartFee(_confTarget: number, _mode: 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'): Promise<any> {
    return this.fetchJson('/v1/fees/recommended');
  }

  // ================= Blocks: basic chain state =================

  async getBlockHeight(): Promise<number> {
    const h = await this.fetchText('/blocks/tip/height');
    const n = Number((h ?? '').trim());
    if (!Number.isFinite(n)) throw new Error('Invalid tip height');
    return n;
  }

  async getTipHash(): Promise<string> {
    return (await this.fetchText('/blocks/tip/hash')).trim();
  }

  // ================= Blocks: height <-> hash =================

  /**
   * Improved: tries to use /blocks/:start_height in dense ranges,
   * falls back to /block-height/:h for sparse points.
   * Order of the output strictly matches input indices.
   */
  async getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]> {
    if (!Array.isArray(heights) || heights.length === 0) return [];

    // Preserve output order
    const out: (string | null)[] = new Array(heights.length).fill(null);

    // Work on a sorted unique copy to detect dense runs
    const uniqSorted = Array.from(new Set(heights.filter((h) => Number.isFinite(h)))).sort((a, b) => a - b);

    // Find maximal runs with step=1
    type Run = { start: number; end: number; len: number };
    const runs: Run[] = [];
    let runStart = uniqSorted[0];
    let prev = uniqSorted[0]!;

    for (let i = 1; i < uniqSorted.length; i++) {
      const h = uniqSorted[i]!;
      if (h === prev + 1) {
        prev = h;
        continue;
      }
      // close previous run
      runs.push({ start: runStart!, end: prev!, len: prev! - runStart! + 1 });
      // start new
      runStart = h;
      prev = h;
    }
    // close last run
    if (uniqSorted.length) runs.push({ start: runStart!, end: prev!, len: prev! - runStart! + 1 });

    // Heuristic: treat a run as "dense" if len >= 6 (tweak if needed)
    const DENSE_MIN_LEN = 6;

    // First pass: fetch dense ranges via /blocks/:start_height pages
    const denseMaps: Array<Map<number, string>> = [];
    for (const r of runs) {
      if (r.len >= DENSE_MIN_LEN) {
        // Esplora pages are descending from start_height
        const map = await this.fetchBlocksRangeViaPages(r.end /*highest? lowest?*/, r.start /*lowest?*/);
        // Careful: fetchBlocksRangeViaPages expects startHeight >= endHeight (descending).
        // r.start <= r.end since uniqSorted is ascending. We need start = r.end, end = r.start
        denseMaps.push(map);
      }
    }

    // Build a global lookup from dense results
    const denseLookup = new Map<number, string>();
    for (const m of denseMaps) {
      for (const [h, hash] of m.entries()) denseLookup.set(h, hash);
    }

    // Fill what we already know for original order
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i]!;
      const got = denseLookup.get(h);
      if (got) out[i] = got;
    }

    // Gather remaining heights for sparse single-call fallback
    const remaining: number[] = [];
    const positions: number[] = []; // to map responses back into `out`
    for (let i = 0; i < heights.length; i++) {
      if (out[i] == null) {
        remaining.push(heights[i]!);
        positions.push(i);
      }
    }
    if (remaining.length === 0) return out;

    // Do sparse calls via RateLimiter, preserving order
    const reqs = remaining.map((h) => ({ method: `/block-height/${h}`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const res: (string | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          const s = await this.fetchText(batch[i]!.method);
          res[i] = typeof s === 'string' && s.trim() ? s.trim() : null;
        } catch {
          res[i] = null;
        }
      }
      return res;
    });

    // Map back to output indices
    for (let j = 0; j < rows.length; j++) {
      out[positions[j]!] = rows[j] ?? null;
    }

    return out;
  }

  async getHeightsByHashes(hashes: string[]): Promise<(number | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const statusReqs = hashes.map((h) => ({ method: `/block/${h}/status`, params: [] as any[] }));
    const statuses = await this.limiter.execute(statusReqs, async (batch) => {
      const out: (any | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          out[i] = await this.fetchJson(batch[i]!.method);
        } catch {
          out[i] = null;
        }
      }
      return out;
    });

    const out: (number | null)[] = new Array(hashes.length).fill(null);
    for (let i = 0; i < hashes.length; i++) {
      const st = statuses[i];
      if (st && typeof st.block_height === 'number') {
        out[i] = st.block_height;
      } else {
        try {
          const meta = await this.fetchJson(`/block/${hashes[i]}`);
          out[i] = meta && typeof meta.height === 'number' ? meta.height : null;
        } catch {
          out[i] = null;
        }
      }
    }
    return out;
  }

  // ================= Blocks: raw / headers / verbose / stats =================

  async requestHexBlocks(hashes: string[]): Promise<(Uint8Array | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const reqs = hashes.map((h) => ({ method: `/block/${h}/raw`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const out: (Uint8Array | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          const b = await this.fetchBinary(batch[i]!.method);
          out[i] = b instanceof Uint8Array ? b : null;
        } catch {
          out[i] = null;
        }
      }
      return out;
    });
    return rows;
  }

  async getBlockHeadersByHashes(hashes: string[]): Promise<(ByteData | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const reqs = hashes.map((h) => ({ method: `/block/${h}/header`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const out: (ByteData | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          const hex = await this.fetchText(batch[i]!.method);
          const trimmed = (hex ?? '').trim();
          out[i] = trimmed ? Uint8Array.from(Buffer.from(trimmed, 'hex')) : null;
        } catch {
          out[i] = null;
        }
      }
      return out;
    });
    return rows;
  }

  async getRawBlocksByHashesVerbose(hashes: string[], _verbosity: 1 | 2 = 1): Promise<(any | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const reqs = hashes.map((h) => ({ method: `/block/${h}`, params: [] as any[] }));
    const rows = await this.limiter.execute(reqs, async (batch) => {
      const out: (any | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          out[i] = await this.fetchJson(batch[i]!.method);
        } catch {
          out[i] = null;
        }
      }
      return out;
    });
    return rows;
  }

  /* eslint-disable no-empty */
  async getBlockStatsByHashes(hashes: string[]): Promise<(any | null)[]> {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const metaReqs = hashes.map((h) => ({ method: `/block/${h}`, params: [] as any[] }));
    const metas = await this.limiter.execute(metaReqs, async (batch) => {
      const out: (any | null)[] = new Array(batch.length).fill(null);
      for (let i = 0; i < batch.length; i++) {
        try {
          out[i] = await this.fetchJson(batch[i]!.method);
        } catch {
          out[i] = null;
        }
      }
      return out;
    });

    const out: (any | null)[] = new Array(hashes.length).fill(null);
    for (let i = 0; i < hashes.length; i++) {
      const m = metas[i];
      if (!m) {
        out[i] = null;
        continue;
      }
      if (typeof m.tx_count !== 'number') {
        try {
          const txids = await this.fetchJson(`/block/${hashes[i]}/txids`);
          m.tx_count = Array.isArray(txids) ? txids.length : undefined;
        } catch {}
      }
      out[i] = {
        height: m.height,
        time: m.timestamp ?? m.time,
        total_size: m.size,
        total_weight: m.weight,
        txs: m.tx_count,
      };
    }
    return out;
  }
  /* eslint-enable no-empty */

  // ================= Network info (best-effort) =================

  async getBlockchainInfo(): Promise<any> {
    const [height, hash] = await Promise.all([this.getBlockHeight(), this.getTipHash().catch(() => undefined)]);
    return { chain: 'bitcoin', blocks: height, bestblockhash: hash };
  }

  async getNetworkInfo(): Promise<any> {
    throw new Error('getNetworkInfo() method is not implemented for this transport');
  }
}
