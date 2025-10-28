import type { Logger } from '@nestjs/common';
import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, Transaction, MempoolTxMetadata } from '../../../blockchain-provider';
import {
  BitcoinMempoolInitializedEvent,
  // BitcoinMempoolInitialSynchronizedEvent,
  BitcoinMempoolRefreshedEvent,
  BitcoinMempoolSyncProcessedEvent,
  BitcoinMempoolSynchronizedEvent,
} from '../../events';
import { hashTxid32, TxIndex, MetadataStore, TxStore, LoadTracker, ProviderTxMap, BatchSizer } from './components';
import type { LightTransaction, LightVin, LightVout } from '../interfaces';

export type ProviderSnapshot = Record<
  string, // provider name
  Array<{ txid: string; metadata: MempoolTxMetadata }>
>;

/**
 * Event-sourced mempool aggregate.
 *
 * Responsibilities (all state changes only via event handlers):
 * - Hold the deduped provider snapshot (provider→tx hash, txid index, metadata).
 * - Load full/slim transactions in provider-sliced adaptive batches (BatchSizer).
 * - Detect vanished transactions (confirmed/evicted/RBF) lazily; pruning happens on next snapshot.
 * - Drive recursion exclusively through events (no loops inside commands).
 * - Emit one-time initial synchronization event after passing a threshold.
 *
 * Commands:
 * - init(): emit "Initialized" (acts as start signal; initialSyncDone=false window opens).
 * - refresh(): receive provider snapshot, filter by fee & dedup, emit "Refreshed".
 * - sync(): one batch tick: fetch slim txs per provider slice, emit "SyncProcessed";
 *           if nothing pending — emit "Synchronized" (cycle complete under current fence).
 *
 * Complexity (per tick):
 * - Build pending map: O(P + N_fence) with O(1) set lookups by hash.
 * - Provider fetches: parallel; size per provider controlled by BatchSizer.
 * - Event emission proportional to loaded tx count.
 */
export class Mempool extends AggregateRoot {
  private minFeeRate: number; // sats/vB filter for metadata
  private batchSizer = new BatchSizer(500, 50, 10_000);
  private prevDuration: Map<string, number> | undefined;
  private txIndex = new TxIndex(); // hash32 -> txid (and reverse)
  private metaStore = new MetadataStore(); // hash32 -> metadata (from chosen provider)
  private txStore = new TxStore(); // hash32 -> slim tx (loaded)
  private loadTracker = new LoadTracker(); // hash32 -> { timestamp, feeRate, providerName }
  private providerTx = new ProviderTxMap(); // provider -> Set<hash32>

  constructor({
    aggregateId,
    blockHeight,
    minFeeRate = 1,
    options,
  }: {
    aggregateId: string;
    blockHeight: number;
    minFeeRate?: number;
    options?: any;
  }) {
    super(aggregateId, blockHeight, options);
    this.minFeeRate = minFeeRate;
  }

  // ====================================================================================
  // Utilities
  // ====================================================================================

  /** sats/vB from metadata; assumes all fee fields are already in smallest units (sats). */
  private feeRateFromMeta(m: MempoolTxMetadata): number {
    const vsize = Number(m.vsize);
    if (!Number.isFinite(vsize) || vsize <= 0) return NaN;

    if (typeof m.fee === 'number' && Number.isFinite(m.fee)) return m.fee / vsize;
    if (typeof (m as any).modifiedfee === 'number' && Number.isFinite((m as any).modifiedfee)) {
      return (m as any).modifiedfee / vsize;
    }

    const f = (m as any).fees as
      | { base?: number; modified?: number; ancestor?: number; descendant?: number }
      | undefined;

    if (f) {
      if (typeof f.modified === 'number' && Number.isFinite(f.modified)) return f.modified / vsize;
      if (typeof f.base === 'number' && Number.isFinite(f.base)) return f.base / vsize;
      if (typeof f.ancestor === 'number' && Number.isFinite(f.ancestor)) return f.ancestor / vsize;
      if (typeof f.descendant === 'number' && Number.isFinite(f.descendant)) return f.descendant / vsize;
    }
    return NaN;
  }

  /** Normalize full tx → slim LightTransaction (keeps only fields needed for mempool UI/logic). */
  private normalize(full: Transaction): LightTransaction {
    const lightVin: LightVin[] = (full.vin ?? []).map(
      (v): LightVin => ({
        txid: v.txid,
        vout: v.vout,
        sequence: v.sequence,
      })
    );

    const lightVout: LightVout[] = (full.vout ?? []).map(
      (o): LightVout => ({
        value: o.value,
        n: o.n,
        scriptPubKey: o.scriptPubKey
          ? {
              type: o.scriptPubKey.type,
              addresses: o.scriptPubKey.addresses,
              hex: o.scriptPubKey.hex,
            }
          : undefined,
      })
    );

    return {
      txid: full.txid,
      hash: full.hash,
      version: full.version,
      size: full.size,
      strippedsize: full.strippedsize,
      sizeWithoutWitnesses: full.sizeWithoutWitnesses,
      vsize: full.vsize,
      weight: full.weight,
      locktime: full.locktime,
      vin: lightVin,
      vout: lightVout,
      feeRate: full.feeRate, // may be absent upstream; kept if present
    };
  }

  /* ---------------------------- Snapshot serialize/restore ---------------------------- */
  protected serializeUserState(): Record<string, any> {
    return {
      minFeeRate: this.minFeeRate,
      // snapshot-able maps
      txIndex_h2s: this.txIndex.__getMap(),
      providerTx_map: this.providerTx.__getMap(),
      metaStore_map: this.metaStore.__getMap(),
      txStore_map: this.txStore.__getMap(),
      loadTracker_map: this.loadTracker.__getMap(),
    };
  }

  protected restoreUserState(state: any): void {
    this.minFeeRate = typeof state?.minFeeRate === 'number' ? state.minFeeRate : 1;

    const toMap = <K, V>(m: unknown): Map<K, V> =>
      m instanceof Map ? m : Array.isArray(m) ? new Map(m as any) : new Map();

    const toMapStringToSetNumber = (m: unknown): Map<string, Set<number>> => {
      if (m instanceof Map) return m as Map<string, Set<number>>;
      const out = new Map<string, Set<number>>();
      if (Array.isArray(m)) {
        for (const [k, v] of m as any[]) {
          out.set(String(k), v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
        }
      } else if (m && typeof m === 'object') {
        for (const k of Object.keys(m as any)) {
          const v = (m as any)[k];
          if (v instanceof Set) out.set(String(k), v);
          else if (Array.isArray(v)) out.set(String(k), new Set(v));
        }
      }
      return out;
    };

    this.batchSizer = new BatchSizer(500, 50, 10_000);
    this.prevDuration = undefined;

    this.txIndex = new TxIndex();
    this.providerTx = new ProviderTxMap();
    this.metaStore = new MetadataStore();
    this.txStore = new TxStore();
    this.loadTracker = new LoadTracker();

    this.txIndex.__setMap(toMap<number, string>(state?.txIndex_h2s));
    this.providerTx.__setMap(toMapStringToSetNumber(state?.providerTx_map));
    this.metaStore.__setMap(toMap<number, MempoolTxMetadata>(state?.metaStore_map));
    this.txStore.__setMap(toMap<number, LightTransaction>(state?.txStore_map));
    this.loadTracker.__setMap(toMap<number, any>(state?.loadTracker_map));

    Object.setPrototypeOf(this, Mempool.prototype);
  }

  // ====================================================================================
  // Commands (no state mutation here!)
  // ====================================================================================

  /** App startup: open the initial-sync window and signal the system to begin. */
  public async init({ requestId, height, logger }: { requestId: string; height: number; logger: Logger }) {
    // Event handler will flip initialSyncDone = false and (optionally) trigger external refresh flow.
    this.apply(
      new BitcoinMempoolInitializedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: height }, {})
    );

    logger.log('Mempool successfully initialized', {
      args: {
        lastHeight: height,
      },
    });
  }

  /**
   * Accept a fresh provider snapshot prepared by the service.
   * Business rules:
   * - Filter by minFeeRate (done here before emitting event).
   * - Dedup across providers (guard; service also dedupes).
   * State update will happen in the Refreshed handler.
   */
  public async refresh({
    requestId,
    height,
    perProvider,
    logger,
  }: {
    requestId: string;
    height: number;
    perProvider: ProviderSnapshot;
    logger: Logger;
  }) {
    // Build filtered+deduped snapshot WITHOUT touching state.
    const seen = new Set<string>();
    const filtered: ProviderSnapshot = {};

    for (const [provider, items] of Object.entries(perProvider)) {
      if (!Array.isArray(items) || items.length === 0) continue;

      const out: Array<{ txid: string; metadata: MempoolTxMetadata }> = [];
      for (const { txid, metadata } of items) {
        if (!txid || seen.has(txid)) continue;

        const fee = this.feeRateFromMeta(metadata);
        if (!Number.isFinite(fee) || fee < this.minFeeRate) continue;

        seen.add(txid);
        out.push({ txid, metadata });
      }
      if (out.length > 0) filtered[provider] = out;
    }

    this.apply(
      new BitcoinMempoolRefreshedEvent(
        { aggregateId: this.aggregateId, requestId, blockHeight: height },
        { aggregatedMetadata: filtered }
      )
    );
    logger.log('Mempool refreshed.');
  }

  /**
   * One sync tick.
   * Steps:
   *  1) If initial sync not announced yet and threshold reached → emit InitialSynchronized (do not exit).
   *  2) Build per-provider pending list under the current snapshot fence (skip already-loaded).
   *  3) For each provider, take an adaptive slice and fetch txs in parallel.
   *  4) Normalize & emit SyncProcessed (handler will persist txs & loadTracker).
   *  5) If no pending left → emit Synchronized (cycle complete).
   *
   * NOTE: No state mutation inside this command; only via event handlers.
   */
  public async sync({
    requestId,
    service,
    logger,
  }: {
    requestId: string;
    service: BlockchainProviderService;
    logger: Logger;
  }) {
    // // (1) Initial-sync threshold check (emit once; handler flips the flag).
    // if (!this.initialSyncDone) {
    //   const expected = this.metaStore.size();
    //   const loaded = this.loadTracker.count();
    //   if (expected > 0 && loaded / expected >= this.syncThresholdPercent) {
    //     this.apply(
    //       new BitcoinMempoolInitialSynchronizedEvent(
    //         { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
    //         {}
    //       )
    //     );
    //   }
    // }

    // (2) Build pending list per provider (fenced by last snapshot).
    const byProvider = new Map<string, string[]>(); // provider -> txids to try this tick

    for (const provider of this.providerTx.providers()) {
      const set = this.providerTx.get(provider);
      if (!set) continue;

      const pending: string[] = [];
      for (const h of set) {
        if (this.loadTracker.has(h)) continue; // already loaded
        if (!this.metaStore.has(h)) continue; // pruned by last refresh
        const txid = this.txIndex.getByHash(h);
        if (txid) pending.push(txid);
      }
      if (pending.length > 0) byProvider.set(provider, pending);
    }

    if (byProvider.size === 0) {
      // (5) Nothing left — announce cycle completion for current fence.
      this.apply(
        new BitcoinMempoolSynchronizedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          {}
        )
      );

      logger.log('Mempool synced.', {
        args: { mempool: this.getMemoryUsage() },
      });

      return;
    }

    // (3) Fetch batches in parallel, with adaptive slice per provider.
    const loadedForEvent: Array<{
      txid: string;
      transaction: LightTransaction;
      providerName?: string;
    }> = [];
    const batchDurations: Record<string, number> = {};

    const startedAt = new Map<string, number>();
    const tasks = Array.from(byProvider.entries()).map(([providerName, txids]) =>
      (async () => {
        const size = this.batchSizer.get(providerName);
        const slice = txids.slice(0, size);
        if (slice.length === 0) return;

        try {
          startedAt.set(providerName, Date.now());
          const txs = await service.getMempoolTransactionsByTxids(slice, true, 1, {
            strategy: 'single',
            providerName,
          });

          // Index returns to O(1) check.
          const got = new Map<string, Transaction>();
          for (const t of txs) if (t?.txid) got.set(t.txid, t);

          for (const txid of slice) {
            const full = got.get(txid);
            if (!full) {
              // Vanished under provider: do not mutate state here; next refresh will prune.
              continue;
            }
            const slim = this.normalize(full);
            loadedForEvent.push({ txid: slim.txid, transaction: slim, providerName });
          }
        } catch (e: unknown) {
          logger.debug('sync provider failed', {
            args: { providerName, error: (e as Error)?.message ?? String(e) },
          });
        } finally {
          const start = startedAt.get(providerName) ?? Date.now();
          const duration = Date.now() - start;
          const prev = this.prevDuration?.get(providerName) ?? duration;
          if (!this.prevDuration) this.prevDuration = new Map<string, number>();
          this.prevDuration.set(providerName, duration);
          // ratio > 1 → slower → shrink; ratio < 1 → faster → grow
          this.batchSizer.tune(providerName, duration / (prev || duration));
          batchDurations[providerName] = duration;
        }
      })()
    );

    await Promise.allSettled(tasks);

    // (4) Emit SyncProcessed only if we actually loaded some txs.
    if (loadedForEvent.length > 0) {
      this.apply(
        new BitcoinMempoolSyncProcessedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          { loadedTransactions: loadedForEvent, batchDurations }
        )
      );
    }

    // The recursion is driven by your event consumer (listening to SyncProcessed).
    // If there’s still pending work, consumer calls sync() again; otherwise next call
    // will hit the "nothing pending" path and emit Synchronized.
  }

  // ====================================================================================
  // Event handlers (idempotent!)
  // ====================================================================================

  /** App init signal — open the one-shot window for initial sync. */
  private onBitcoinMempoolInitializedEvent(_: BitcoinMempoolInitializedEvent) {
    // this.initialSyncDone = false;
  }

  /**
   * A fresh provider snapshot accepted (already filtered & deduped by command).
   * Business rules executed here (idempotent):
   *  - Rebuild txIndex/providerTx/metaStore atomically.
   *  - Prune loaded & slim txs that disappeared from the new snapshot.
   *  - Reset BatchSizer tuning window.
   */
  private onBitcoinMempoolRefreshedEvent({ payload }: BitcoinMempoolRefreshedEvent) {
    const per = payload.aggregatedMetadata as ProviderSnapshot;

    const newProviderTx = new ProviderTxMap();
    const newMetaByHash = new Map<number, MempoolTxMetadata>();
    const newTxIndex = new TxIndex();
    const seen = new Set<string>();

    for (const [provider, items] of Object.entries(per || {})) {
      const arr = Array.isArray(items) ? items : [];
      for (const { txid, metadata } of arr) {
        if (!txid || seen.has(txid)) continue;

        // Guard dedup (service + command already ensured this)
        seen.add(txid);
        const h = newTxIndex.add(txid);
        newProviderTx.add(provider, h);
        newMetaByHash.set(h, metadata);
      }
    }

    // Switch to the fresh snapshot.
    const still = new Set<number>(newMetaByHash.keys());

    this.providerTx = newProviderTx;
    this.metaStore.__setMap(newMetaByHash);
    this.txIndex = newTxIndex;

    // Prune loaded/slim that are not present anymore.
    for (const h of Array.from(this.loadTracker.__getMap().keys())) {
      if (!still.has(h)) this.loadTracker.remove(h);
    }
    for (const h of Array.from(this.txStore.__getMap().keys())) {
      if (!still.has(h)) this.txStore.remove(h);
    }

    // Reset tuning window for a new cycle & reopen one-shot initial sync window.
    this.batchSizer.clear();
    this.prevDuration = undefined;
    // this.initialSyncDone = false;
  }

  /** Persist txs loaded on this tick; maintain fee snapshot for telemetry. */
  private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
    const { loadedTransactions } = payload;
    for (const { txid, transaction, providerName } of loadedTransactions || []) {
      const h = hashTxid32(txid);
      if (this.loadTracker.has(h)) continue; // idempotency

      const fee =
        typeof transaction.feeRate === 'number' && Number.isFinite(transaction.feeRate) ? transaction.feeRate : 0;

      this.txStore.set(h, transaction);
      this.loadTracker.add(h, { timestamp: Date.now(), feeRate: fee, providerName });
    }
  }

  /** Flip the one-shot flag when initial synchronization is announced. */
  // private onBitcoinMempoolInitialSynchronizedEvent(_: BitcoinMempoolInitialSynchronizedEvent) {
  //   this.initialSyncDone = true;
  // }

  /** Full cycle complete under current fence; nothing extra to mutate. */
  private onBitcoinMempoolSynchronizedEvent(_: BitcoinMempoolSynchronizedEvent) {
    // No-op: external consumer uses this to stop recursion for this fence.
  }

  // ====================================================================================
  // Read API (O(1) / O(n) helpers)
  // ====================================================================================

  /** O(n): iterate over known txids from current snapshot fence. */
  public *txIds(): Iterable<string> {
    // txIndex.__getMap() stores hash32 -> txid
    // return only the values (txid)
    for (const [, txid] of this.txIndex.__getMap()) {
      yield txid;
    }
  }

  /** O(n): iterate over loaded slim transactions. */
  public *loadedTransactions(): Iterable<LightTransaction> {
    // txStore.__getMap() stores hash32 -> LightTransaction
    for (const [, tx] of this.txStore.__getMap()) {
      yield tx;
    }
  }

  /** Async generator over loaded slim tx. */
  public async *iterLoadedTransactions(): AsyncGenerator<LightTransaction> {
    for (const [, tx] of this.txStore.__getMap()) {
      yield tx;
    }
  }

  public hasTransaction(txid: string): boolean {
    return this.txIndex.hasHash(hashTxid32(txid));
  }

  public isTransactionLoaded(txid: string): boolean {
    return this.loadTracker.has(hashTxid32(txid));
  }

  public getTransactionMetadata(txid: string): MempoolTxMetadata | undefined {
    return this.metaStore.get(hashTxid32(txid));
  }

  public getFullTransaction(txid: string): LightTransaction | undefined {
    return this.txStore.get(hashTxid32(txid));
  }

  public getStats() {
    return {
      txids: this.txIndex.size(),
      metadata: this.metaStore.size(),
      transactions: this.txStore.size(),
      providers: this.providerTx.providers().length,
    };
  }

  /** Rough memory usage breakdown per internal store + total (estimates). */
  public getMemoryUsage(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB'): {
    unit: 'B' | 'KB' | 'MB' | 'GB';
    counts: {
      txids: number;
      metadata: number;
      transactions: number;
      loaded: number;
      providers: number;
    };
    bytes: {
      txIndex: number;
      metadata: number;
      txStore: number;
      loadTracker: number;
      providerTx: number;
      total: number;
    };
  } {
    // Counts
    const txids = this.txIndex.size();
    const metadata = this.metaStore.size();
    const transactions = this.txStore.size();
    const loaded = this.loadTracker.count();
    const providers = this.providerTx.providers().length;

    // Heuristic per-entry sizes (JS Maps/Sets add overhead in practice)
    const txIndexBytes = txids * 72; // ~4B hash + ~64B txid + overhead approx
    const metadataBytes = metadata * 350; // normalized mempool entry
    const txStoreBytes = transactions * 2000; // slim tx ~2KB avg
    const loadTrackerBytes = loaded * 48; // timestamp + feeRate + provider ref
    const providerMapBytes = txids * 60; // provider name refs + set membership overhead

    const totalBytes = txIndexBytes + metadataBytes + txStoreBytes + loadTrackerBytes + providerMapBytes;

    const factor = units === 'B' ? 1 : units === 'KB' ? 1024 : units === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;

    const conv = (b: number) => Math.round((b / factor) * 100) / 100;

    return {
      unit: units,
      counts: { txids, metadata, transactions, loaded, providers },
      bytes: {
        txIndex: conv(txIndexBytes),
        metadata: conv(metadataBytes),
        txStore: conv(txStoreBytes),
        loadTracker: conv(loadTrackerBytes),
        providerTx: conv(providerMapBytes),
        total: conv(totalBytes),
      },
    };
  }
}
