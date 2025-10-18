// import type { Logger } from '@nestjs/common';
// import { AggregateRoot } from '@easylayer/common/cqrs';
// import type { BlockchainProviderService, Transaction, MempoolTxMetadata } from '../../../blockchain-provider';
// import {
//   BitcoinMempoolInitializedEvent,
//   BitcoinMempoolSyncProcessedEvent,
//   BitcoinMempoolClearedEvent,
//   BitcoinMempoolSynchronizedEvent,
// } from '../../events';
// import {
//   hashTxid32,
//   TxIndex,
//   MetadataStore,
//   TxStore,
//   LoadTracker,
//   ProviderTxMap,
//   BatchSizer,
// } from './components';
// import type { LightTransaction, LightVin, LightVout } from '../interfaces';

// /**
//  * Mempool aggregate for unconfirmed transactions synchronization and caching.
//  *
//  * Design Overview:
//  * - Represents mempool state across multiple network providers.
//  * - Maintains consistent mapping: txid ↔ metadata ↔ provider.
//  * - Tracks synchronization progress, adaptive batching, and dynamic rates.
//  * - Supports event-driven incremental loading (init → sync → finalize).
//  *
//  * Memory Strategy:
//  * - TxIndex: 4-byte hash ↔ txid mapping (O(1) lookups, saves ~60B per txid).
//  * - MetadataStore: stores normalized RPC metadata (~300–400B each).
//  * - TxStore: holds slim (lightweight) normalized transactions (~1.5–2KB each).
//  * - LoadTracker: keeps timestamp, feeRate, providerName per loaded tx (~40B each).
//  * - ProviderTxMap: assigns each tx to exactly one provider (no duplicates).
//  *
//  * Synchronization Algorithm:
//  * - init(): loads verbose mempool snapshots from all providers in parallel.
//  * - processSync(): incrementally loads slim txs, adaptive batch sizing per provider.
//  * - processBlocksBatch(): removes confirmed txs, triggers resnapshot.
//  * - processReorganisation(): clears and refreshes after deep reorg.
//  * - clearMempool(): manual full reset.
//  *
//  * Performance:
//  * - Metadata snapshot rebuild: O(P + N)   (P=providers, N=txids)
//  * - Tx load tick: O(P + B)                (B=batch size per provider)
//  * - Fee filtering and deduplication: O(N)
//  * - In-memory lookups (txid → metadata/tx): O(1)
//  * - Adaptive batch tuning: O(1) per provider per tick.
//  *
//  * Memory Usage Estimation (approx):
//  * - TxIndex: 68 bytes × tx_count
//  * - MetadataStore: 350 bytes × tx_count
//  * - TxStore: 2,000 bytes × loaded_tx_count
//  * - ProviderTxMap + LoadTracker: 60 bytes × tx_count
//  * - Example: ~2.5–3MB per 1,000 fully loaded transactions.
//  *
//  * Fault Tolerance:
//  * - Uses Promise.allSettled → failed provider does not affect others.
//  * - Idempotent event handlers → safe to replay.
//  * - Graceful stop via hasMoreToProcess and syncThreshold gates.
//  *
//  * Events Flow:
//  * - BitcoinMempoolInitializedEvent → initial snapshot applied.
//  * - BitcoinMempoolSyncProcessedEvent → partial load tick finished.
//  * - BitcoinMempoolSynchronizedEvent → reached threshold (e.g., 90%).
//  * - BitcoinMempoolClearedEvent → mempool fully reset.
//  *
//  * Complexity Summary:
//  * - Full refresh: O(P + N)
//  * - Incremental sync tick: O(P + B)
//  * - Queries (Read API): O(1) or O(n) depending on scope.
//  *
//  * Typical Use Case:
//  * - Initialize → periodically processSync() until synchronized.
//  * - Read APIs allow real-time queries (fee stats, top txs, loaded state).
//  * - Designed for long-running indexers or mempool monitoring daemons.
//  */
// export class Mempool extends AggregateRoot {
//   /* Tunables */
//   private minFeeRate: number; // sats/vB threshold for metadata filtering
//   private syncThresholdPercent = 0.9;

//   /* One-shot per app run (don't change semantics) */
//   private isSynchronized = false;

//   /* In-memory adaptive batch sizing (not serialized) */
//   private batchSizer = new BatchSizer(500, 50, 10000);
//   private prevDuration: Map<string, number> | undefined;

//   /* Internal stores (snapshot-able) */
//   private txIndex = new TxIndex();
//   private metaStore = new MetadataStore();
//   private txStore = new TxStore();
//   private loadTracker = new LoadTracker();
//   private providerTx = new ProviderTxMap(); // providerName -> Set<txHash>

//   constructor({
//     aggregateId,
//     blockHeight,
//     minFeeRate = 1,
//     options,
//   }: {
//     aggregateId: string;
//     blockHeight: number;
//     minFeeRate?: number;
//     options?: any;
//   }) {
//     super(aggregateId, blockHeight, options );
//     this.minFeeRate = minFeeRate;
//   }

//   /* ===================== Utilities ======================================= */

//   /** Calculate fee rate in sat/vB from metadata; NaN if impossible. */
//   private feeRateFromMeta(m: MempoolTxMetadata): number {
//     const anyM = m;
//     const vsize = Number(anyM?.vsize);
//     if (!Number.isFinite(vsize) || vsize <= 0) return NaN;

//     // try BTC fee
//     if (typeof anyM.fee === 'number' && anyM.fee > 0) {
//       const sats = Math.round(anyM.fee * 1e8);
//       return sats / vsize;
//     }
//     // nested fee (already sats per vB in many providers) or family fees
//     const f = anyM.fees || {};
//     const cand =
//       (typeof f.modified === 'number' && f.modified) ||
//       (typeof f.base === 'number' && f.base) ||
//       (typeof f.ancestor === 'number' && f.ancestor) ||
//       (typeof f.descendant === 'number' && f.descendant) ||
//       0;
//     return Math.round(cand) / 1; // treat as sats/vB
//   }

//   /**
//    * Normalize full transaction into lightweight form.
//    * Keeps only essential fields (for mempool processing, RBF checks, fee stats).
//    *
//    * Complexity: O(vin + vout)
//    * Average size reduction: ~10× smaller than full RPC transaction.
//    */
//   private static normalize(full: Transaction): LightTransaction {
//     // Compact inputs (vin)
//     const lightVin: LightVin[] = (full.vin ?? []).map((v): LightVin => ({
//       txid: v.txid,
//       vout: v.vout,
//       sequence: v.sequence,
//     }));

//     // Compact outputs (vout)
//     const lightVout: LightVout[] = (full.vout ?? []).map((o): LightVout => ({
//       value: o.value,
//       n: o.n,
//       scriptPubKey: o.scriptPubKey
//         ? {
//             type: o.scriptPubKey.type,
//             addresses: o.scriptPubKey.addresses,
//             hex: o.scriptPubKey.hex,
//           }
//         : undefined,
//     }));

//     // Assemble light version
//     const lightTx: LightTransaction = {
//       txid: full.txid,
//       hash: full.hash,
//       version: full.version,
//       size: full.size,
//       strippedsize: full.strippedsize,
//       sizeWithoutWitnesses: full.sizeWithoutWitnesses,
//       vsize: full.vsize,
//       weight: full.weight,
//       locktime: full.locktime,
//       vin: lightVin,
//       vout: lightVout,
//       feeRate: full.feeRate, // optional, might not be present upstream
//     };

//     return lightTx;
//   }

//     /* ---------------------------- Snapshot serialize/restore ---------------------------- */
//   protected serializeUserState(): Record<string, any> {
//     return {
//       minFeeRate: this.minFeeRate,
//       syncThresholdPercent: this.syncThresholdPercent,
//       isSynchronized: this.isSynchronized,
//       // Snapshot internal maps (Maps/Sets will be handled by restore helpers)
//       txIndex_h2s: this.txIndex.__getMap(),
//       providerTx_map: this.providerTx.__getMap(),
//       metaStore_map: this.metaStore.__getMap(),
//       txStore_map: this.txStore.__getMap(),
//       loadTracker_map: this.loadTracker.__getMap(),
//     };
//   }

//   protected restoreUserState(state: any): void {
//     // Primitives / tunables
//     this.minFeeRate = typeof state?.minFeeRate === 'number' ? state.minFeeRate : 1;
//     this.syncThresholdPercent = typeof state?.syncThresholdPercent === 'number' ? state.syncThresholdPercent : 0.9;
//     this.isSynchronized = !!state?.isSynchronized;

//     // Helpers to reconstruct Maps/Sets from plain objects/arrays/Maps
//     const toMap = <K, V>(m: any): Map<K, V> => (m instanceof Map ? m : Array.isArray(m) ? new Map(m) : new Map());
//     const toMapStringToSetNumber = (m: any): Map<string, Set<number>> => {
//       if (m instanceof Map) return m as Map<string, Set<number>>;
//       const out = new Map<string, Set<number>>();
//       if (Array.isArray(m)) {
//         for (const [k, v] of m) out.set(String(k), v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
//       } else if (m && typeof m === 'object') {
//         for (const k of Object.keys(m)) {
//           const v = (m as any)[k];
//           if (v instanceof Set) out.set(String(k), v);
//           else if (Array.isArray(v)) out.set(String(k), new Set(v));
//         }
//       }
//       return out;
//     };

//     // Re-create instances before applying internal maps
//     this.txIndex = new TxIndex();
//     this.providerTx = new ProviderTxMap();
//     this.metaStore = new MetadataStore();
//     this.txStore = new TxStore();
//     this.loadTracker = new LoadTracker();

//     // Apply maps
//     this.txIndex.__setMap(toMap<number, string>(state?.txIndex_h2s));
//     this.providerTx.__setMap(toMapStringToSetNumber(state?.providerTx_map));
//     this.metaStore.__setMap(toMap<number, MempoolTxMetadata>(state?.metaStore_map));
//     this.txStore.__setMap(toMap<number, LightTransaction>(state?.txStore_map));
//     this.loadTracker.__setMap(toMap<number, any>(state?.loadTracker_map));

//     // Ensure prototype stays intact after restore in some runtimes
//     Object.setPrototypeOf(this, Mempool.prototype);
//   }

//   /* ===================== Commands ======================================== */

//   /** Initialize by refreshing verbose snapshots across all providers. */
//   public async init({
//     requestId,
//     currentNetworkHeight,
//     service,
//     logger,
//   }: {
//     requestId: string;
//     currentNetworkHeight: number;
//     service: BlockchainProviderService;
//     logger: Logger;
//   }) {
//     const providerNames = service.getAllMempoolProviderNames();
//     if (!providerNames || providerNames.length === 0) {
//       throw new Error('Mempool initialization failed: no active mempool providers available');
//     }

//     return this.refreshFromVerboseSnapshot({
//       requestId,
//       height: currentNetworkHeight,
//       service,
//       logger,
//       isSynchronized: false, // custom semantics: always false on first init
//     });
//   }

//   /**
//    * Refresh mempool snapshot:
//    * - fetch verbose mempool for each provider in parallel
//    * - rebuild provider -> metadata[] map with dedup across providers
//    * - filter by fee (minFeeRate)
//    * - emit BitcoinMempoolInitializedEvent
//    *
//    * Complexity: O(P + N) over returned entries.
//    */
//   private async refreshFromVerboseSnapshot({
//     requestId,
//     height,
//     service,
//     logger,
//     isSynchronized = true,
//   }: {
//     requestId: string;
//     height: number;
//     service: BlockchainProviderService;
//     logger: Logger;
//     isSynchronized?: boolean;
//   }) {
//     const results = await service.getRawMempoolFromAll(true);
//     if (!Array.isArray(results) || results.length === 0) {
//       logger.warn('Mempool metadata list is empty');
//     }

//     // Dedup across providers: pick the first provider that reports a txid.
//     const seenTxids = new Set<string>();
//     const perProvider: Record<string, MempoolTxMetadata[]> = {};

//     for (const { providerName, value } of results) {
//       if (!value || typeof value !== 'object') continue;
//       if (!providerName) continue;
//       const metaMap = value as Record<string, MempoolTxMetadata>;
//       for (const [txid, meta] of Object.entries(metaMap)) {
//         if (seenTxids.has(txid)) continue; // already assigned to another provider
//         const fr = this.feeRateFromMeta(meta);
//         if (!Number.isFinite(fr) || fr < this.minFeeRate) continue; // drop low-fee entries
//         seenTxids.add(txid);
//         if (!perProvider[providerName]) perProvider[providerName] = [];
//         perProvider[providerName]!.push(meta);
//       }
//     }

//     this.apply(
//       new BitcoinMempoolInitializedEvent(
//         { aggregateId: this.aggregateId, requestId, blockHeight: height },
//         { aggregatedMetadata: perProvider, isSynchronized }
//       )
//     );

//     logger.log('Mempool refreshed', { args: { mempoolSize: this.getStats(), memory: this.getMemoryUsage() } });
//   }

//   /**
//    * === processSync ============================================================
//    * Periodic synchronization method for loading *slim* transactions
//    * that were not yet fetched in full form from providers.
//    *
//    * Behavior:
//    * - Runs per tick (timer/saga). No event-driven recursion guard needed.
//    * - Each tick loads an adaptive-size batch per provider.
//    * - If there is nothing to load → exit silently (no event).
//    * - If nothing was loaded this tick → exit silently (no event).
//    * - Emit SyncProcessed only when we actually loaded transactions.
//    *
//    * Complexity: O(P + ΣB_i) per tick (P = providers, B_i = batch size per provider).
//    */
//   public async processSync({
//     requestId,
//     service,
//     logger,
//   }: {
//     requestId: string;
//     service: BlockchainProviderService;
//     logger: Logger;
//   }) {
//     // ---------------------------------------------------------------------------
//     // 1) Progress gate (synchronization threshold)
//     // ---------------------------------------------------------------------------
//     if (!this.isSynchronized) {
//       const expected = this.metaStore.size();
//       const loaded = this.loadTracker.count();
//       const p = expected > 0 ? loaded / expected : 0;
//       if (p >= this.syncThresholdPercent) {
//         this.apply(
//           new BitcoinMempoolSynchronizedEvent(
//             { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
//             { isSynchronized: true }
//           )
//         );
//         return;
//       }
//     }

//     // ---------------------------------------------------------------------------
//     // 2) Build pending map (self-heal broken hashes)
//     // ---------------------------------------------------------------------------
//     // For each provider, collect tx hashes that are not yet loaded.
//     // If a hash doesn't resolve to a txid in the current TxIndex (stale),
//     // drop it from ProviderTxMap to prevent infinite spinning.
//     const pendingByProvider = new Map<string, number[]>();

//     for (const provider of this.providerTx.providers()) {
//       const set = this.providerTx.get(provider);
//       if (!set) continue;

//       const pending: number[] = [];
//       for (const h of set) {
//         if (this.loadTracker.has(h)) continue;
//         const txid = this.txIndex.getByHash(h);
//         if (txid) pending.push(h);
//         else set.delete(h); // self-heal: remove stale hash → no more empty batches
//       }
//       if (pending.length > 0) pendingByProvider.set(provider, pending);
//     }

//     // Nothing to process → stop silently (no event, no recursion)
//     if (pendingByProvider.size === 0) {
//       logger.log('Mempool synced', { args: { mempoolSize: this.getStats(), memory: this.getMemoryUsage() } });
//       return;
//     }

//     // ---------------------------------------------------------------------------
//     // 3) Execute provider batches in parallel (fault-tolerant)
//     // ---------------------------------------------------------------------------
//     const loadedForEvent: Array<{ txid: string; transaction: LightTransaction; providerName?: string }> = [];
//     const batchDurations: Record<string, number> = {};
//     const startedAt = new Map<string, number>();

//     const tasks = Array.from(pendingByProvider.entries()).map(([providerName, hashes]) => (async () => {
//       const batchSize = this.batchSizer.get(providerName);
//       const txids = hashes
//         .slice(0, batchSize)              // pick up to batch size
//         .map((h) => this.txIndex.getByHash(h)!)
//         .filter(Boolean);                 // resolve hash → txid

//       if (txids.length === 0) return;

//       try {
//         startedAt.set(providerName, Date.now());
//         const txs = await service.getMempoolTransactionsByTxids(txids, true, 1, {
//           strategy: 'single',
//           providerName,
//         });
//         for (const full of txs) {
//           if (!full?.txid) continue;
//           const slim = Mempool.normalize(full);
//           loadedForEvent.push({ txid: slim.txid, transaction: slim, providerName });
//         }
//       } catch (e) {
//         logger?.debug?.('processSync provider batch failed', {
//           args: { providerName, error: (e as any)?.message ?? String(e) },
//         });
//       } finally {
//         const start = startedAt.get(providerName) ?? Date.now();
//         const duration = Date.now() - start;
//         const prev = this.prevDuration?.get(providerName) ?? duration;
//         if (!this.prevDuration) this.prevDuration = new Map<string, number>();
//         this.prevDuration.set(providerName, duration);
//         // duration/prev: >1 → slower → shrink; <1 → faster → grow
//         this.batchSizer.tune(providerName, duration / (prev || duration));
//         batchDurations[providerName] = duration;
//       }
//     })());

//     await Promise.allSettled(tasks);

//     // ---------------------------------------------------------------------------
//     // 4) Emit results only on real progress
//     // ---------------------------------------------------------------------------
//     if (loadedForEvent.length === 0) return;

//     this.apply(
//       new BitcoinMempoolSyncProcessedEvent(
//         { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
//         { loadedTransactions: loadedForEvent, batchDurations }
//       )
//     );
//   }

//   public async refresh({
//     requestId,
//     height,
//     service,
//     logger,
//   }: {
//     requestId: string;
//     height: number;
//     service: BlockchainProviderService;
//     logger: Logger;
//   }) {
//     return this.refreshFromVerboseSnapshot({ requestId, height, service, logger });
//   }

//   public clearMempool({ requestId }: { requestId: string }) {
//     this.apply(new BitcoinMempoolClearedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight }, {}));
//   }

//   /* ===================== Event handlers (IDEMPOTENT) ====================== */

//   private onBitcoinMempoolInitializedEvent({ payload }: BitcoinMempoolInitializedEvent) {
//     const { aggregatedMetadata, isSynchronized } = payload;

//     const newProviderTx = new ProviderTxMap();
//     const newMetaByHash = new Map<number, MempoolTxMetadata>();
//     const newTxIndex = new TxIndex();

//     const seen = new Set<string>();

//     for (const [provider, metas] of Object.entries(aggregatedMetadata || {})) {
//       const arr = Array.isArray(metas) ? metas : [];
//       for (const meta of arr) {
//         const txid =
//           (meta as any)?.txid ||
//           (meta as any)?.wtxid ||
//           (meta as any)?.id;
//         if (!txid || typeof txid !== 'string') continue;
//         if (seen.has(txid)) continue;
//         seen.add(txid);

//         // IMPORTANT: always register into the NEW index and use its hash
//         const h = newTxIndex.add(txid);
//         newProviderTx.add(provider, h);
//         newMetaByHash.set(h, meta);
//       }
//     }

//     // All hashes present in the fresh snapshot
//     const stillPresent = new Set<number>(newMetaByHash.keys());

//     // Switch to the new structures
//     this.providerTx = newProviderTx;
//     this.metaStore.__setMap(newMetaByHash);
//     this.txIndex = newTxIndex;

//     // Drop loaded and slim-transactions that are no longer present in the snapshot
//     for (const h of Array.from(this.loadTracker.__getMap().keys())) {
//       if (!stillPresent.has(h)) this.loadTracker.remove(h);
//     }
//     for (const h of Array.from(this.txStore.__getMap().keys())) {
//       if (!stillPresent.has(h)) this.txStore.remove(h);
//     }

//     // Preserve "flip once per app run" semantics for isSynchronized
//     if (isSynchronized === false) this.isSynchronized = false;
//   }

//   private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
//     const { loadedTransactions } = payload;
//     for (const { txid, transaction, providerName } of loadedTransactions) {
//       const h = hashTxid32(txid);

//       // Idempotency guard: already loaded -> skip
//       if (this.loadTracker.has(h)) continue;

//       const meta = this.metaStore.get(h);
//       if (!meta) continue; // can be raced out by a refresh/reorg

//       // Prefer feeRate from transaction if present, otherwise derive from metadata
//       const frFromTx = typeof transaction.feeRate === 'number' ? transaction.feeRate : NaN;
//       const frFromMeta = this.feeRateFromMeta(meta);
//       const feeRate = Number.isFinite(frFromTx) ? frFromTx : (Number.isFinite(frFromMeta) ? frFromMeta : 0);

//       this.txStore.set(h, transaction);
//       this.loadTracker.add(h, { timestamp: Date.now(), feeRate, providerName });
//     }
//   }

//   private onBitcoinMempoolClearedEvent(_: BitcoinMempoolClearedEvent) {
//     this.metaStore.clear();
//     this.txStore.clear();
//     this.loadTracker.clear();
//     this.providerTx.clear();
//     // Important: batchSizer is runtime-only, but when mempool is empty we reset tuning.
//     this.batchSizer.clear();
//     this.prevDuration = undefined;
//   }

//   private onBitcoinMempoolSynchronizedEvent({ payload }: BitcoinMempoolSynchronizedEvent) {
//     if (payload.isSynchronized && !this.isSynchronized) {
//       this.isSynchronized = true;
//     }
//   }

//   // ======= Read API =========================================================

//   /** O(n) – returns all txids currently tracked. */
//   public getCurrentTxids(): string[] {
//     const out: string[] = [];
//     for (const [h, txid] of this.txIndex.__getMap().entries()) {
//       out.push(txid);
//     }
//     return out;
//   }

//   /** O(1) – get metadata for txid if present. */
//   public getTransactionMetadata(txid: string): MempoolTxMetadata | undefined {
//     return this.metaStore.get(hashTxid32(txid));
//   }

//   /** O(1) – get slim transaction (LightTransaction) for txid. */
//   public getFullTransaction(txid: string): LightTransaction | undefined {
//     return this.txStore.get(hashTxid32(txid));
//   }

//   /** O(1) – existence check. */
//   public hasTransaction(txid: string): boolean {
//     return this.txIndex.hasHash(hashTxid32(txid));
//   }

//   /** O(1) – whether slim tx already loaded. */
//   public isTransactionLoaded(txid: string): boolean {
//     return this.loadTracker.has(hashTxid32(txid));
//   }

//   /** O(p) – list provider names that reported / own this tx (deduped). */
//   public getProvidersForTransaction(txid: string): string[] {
//     const h = hashTxid32(txid);
//     const names: string[] = [];
//     for (const name of this.providerTx.providers()) {
//       const set = this.providerTx.get(name);
//       if (set && set.has(h)) names.push(name);
//     }
//     return names;
//   }

//   /** O(n) – collect txids by feeRate threshold using metadata (fast, cheap). */
//   public getTransactionsAboveFeeRate(minFeeRate: number): string[] {
//     const out: string[] = [];
//     for (const [h, m] of this.metaStore.__getMap().entries()) {
//       const fr = this.feeRateFromMeta(m);
//       if (Number.isFinite(fr) && fr >= minFeeRate) {
//         const txid = this.txIndex.getByHash(h);
//         if (txid) out.push(txid);
//       }
//     }
//     return out;
//   }

//   /** O(n) – return txs with feeRate in [min, max], sorted desc by feeRate. */
//   public getTransactionsByFeeRateRange(
//     minFeeRate: number,
//     maxFeeRate: number
//   ): Array<{ txid: string; feeRate: number; metadata: MempoolTxMetadata; slim?: LightTransaction }> {
//     const res: Array<{ txid: string; feeRate: number; metadata: MempoolTxMetadata; slim?: LightTransaction }> = [];
//     for (const [h, m] of this.metaStore.__getMap().entries()) {
//       const fr = this.feeRateFromMeta(m);
//       if (Number.isFinite(fr) && fr >= minFeeRate && fr <= maxFeeRate) {
//         const txid = this.txIndex.getByHash(h);
//         if (!txid) continue;
//         res.push({ txid, feeRate: fr, metadata: m, slim: this.txStore.get(h) });
//       }
//     }
//     return res.sort((a, b) => b.feeRate - a.feeRate);
//   }

//   /** O(n log n) – top N by feeRate using metadata. */
//   public getTopTransactionsByFeeRate(limit = 100) {
//     return this.getTransactionsByFeeRateRange(0, Number.POSITIVE_INFINITY).slice(0, limit);
//   }

//     /** O(1) – structure counts for quick telemetry. */
//   public getStats() {
//     return {
//       txids: this.txIndex.size(),
//       metadata: this.metaStore.size(),
//       transactions: this.txStore.size(),
//       providers: this.providerTx.providers().length,
//     };
//   }

//   /** O(1) – rough memory estimate for telemetry/monitoring. */
//   public getMemoryUsage(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB') {
//     const counts = this.getStats();

//     const txidMappings = counts.txids * 72;      // 4B hash + ~64B txid (+overhead approx)
//     const metadataBytes = counts.metadata * 350; // ~350B avg per metadata
//     const slimBytes = counts.transactions * 2000; // ~2KB avg per slim tx
//     const providerMapBytes = counts.txids * 60;   // ~name refs + set pointers (rough)

//     const totalBytes = txidMappings + metadataBytes + slimBytes + providerMapBytes;

//     const factor = (u: 'B'|'KB'|'MB'|'GB') => (
//       u === 'B' ? 1 : u === 'KB' ? 1024 : u === 'MB' ? 1024*1024 : 1024*1024*1024
//     );
//     const f = factor(units);
//     const conv = (b: number) => Math.round((b / f) * 100) / 100;

//     return {
//       unit: units,
//       txidMappings: conv(txidMappings),
//       metadata: conv(metadataBytes),
//       transactions: conv(slimBytes),
//       providerMappings: conv(providerMapBytes),
//       total: conv(totalBytes),
//     };
//   }
// }
