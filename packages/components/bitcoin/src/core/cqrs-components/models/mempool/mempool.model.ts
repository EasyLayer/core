import type { Logger } from '@nestjs/common';
import { AggregateRoot } from '@easylayer/common/cqrs';
import type {
  BlockchainProviderService,
  LightBlock,
  Transaction,
  MempoolTxMetadata,
  MempoolTransaction,
  LightVin,
  LightVout,
} from '../../../blockchain-provider';
import {
  BitcoinMempoolInitializedEvent,
  BitcoinMempoolSyncProcessedEvent,
  BitcoinMempoolClearedEvent,
  BitcoinMempoolSynchronizedEvent,
  BitcoinMempoolBlockBatchProcessedEvent,
} from '../../events';
import { hashTxid32, TxIndex, ProviderMap, MetadataStore, TxStore, LoadTracker } from './components';

/** === BatchPlanner (stateless util) ========================================
 * Responsibility: group txids by providerIndex; optionally slice to total limit.
 * Complexity: O(n), memory: proportional to #txids.
 */
function planBatchesByProvider(txids: string[], providers: ProviderMap, totalLimit: number): Map<number, string[]> {
  const plan = new Map<number, string[]>();
  if (totalLimit <= 0 || txids.length === 0) return plan;

  let taken = 0;
  for (const txid of txids) {
    if (taken >= totalLimit) break;
    const h = hashTxid32(txid);
    const provSet = providers.getProviders(h);
    if (!provSet || provSet.size === 0) continue;

    // Pick *all* providers? No: the requirement is "parallel per provider, no fallback".
    // We choose the first provider in Set order to assign responsibility for this txid’s request.
    // That way each txid appears in exactly one provider batch, avoiding duplicate RPC calls.
    const providerIdx = provSet.values().next().value as number;
    let arr = plan.get(providerIdx);
    if (!arr) {
      arr = [];
      plan.set(providerIdx, arr);
    }
    arr.push(txid);
    taken++;
  }

  return plan;
}

/**
 * Slimming normalizer:
 * Convert heavy Transaction → MempoolTransaction immediately (omit large fields, keep only what's needed).
 * Complexity: O(#vin + #vout)
 */
function normalizeToMempoolTx(tx: Transaction): MempoolTransaction {
  // keep only what watcher needs for conflicts and RBF signaling
  const lightVin: LightVin[] = (tx.vin ?? []).map((v) => ({
    txid: v.txid,
    vout: v.vout,
    sequence: v.sequence, // needed for BIP-125 signaling check
  }));

  const lightVout: LightVout[] = (tx.vout ?? []).map((o) => ({
    value: o.value,
    n: o.n,
    // preserve type + addresses if present; add hex when available for address derivation
    scriptPubKey: o.scriptPubKey
      ? {
          type: o.scriptPubKey.type,
          addresses: (o.scriptPubKey as any)?.addresses, // keep if verbose form provided
          hex: (o.scriptPubKey as any)?.hex, // keep if verbose form provided
        }
      : undefined,
  }));

  const feeRate = tx.fee && tx.vsize > 0 ? tx.fee / tx.vsize : undefined;

  const slim: MempoolTransaction = {
    txid: tx.txid,
    hash: tx.hash,
    version: tx.version,
    size: tx.size,
    strippedsize: tx.strippedsize,
    sizeWithoutWitnesses: tx.sizeWithoutWitnesses,
    vsize: tx.vsize,
    weight: tx.weight,
    locktime: tx.locktime,
    vin: lightVin,
    vout: lightVout,
    fee: tx.fee,
    feeRate,
    wtxid: tx.wtxid,
    bip125_replaceable: tx.bip125_replaceable, // optional fast flag; model still checks sequences
  };

  return slim;
}

/* =================================== Mempool =================================== */
/**
 * Aggregate responsibilities:
 * - init/reorg: single verbose=true pass across providers, dedupe, fee-filter metadata, build provider map.
 * - processSync: load slim tx for not-yet-loaded high-fee tx, grouped per provider, no fallbacks, parallel.
 * - processBlocksBatch: remove confirmed tx locally; then optionally consult mempool info across providers and
 *   decide whether to refresh verbose snapshot (heuristic).
 * - All internal structures are part of aggregate state and snapshottable.
 */
export class Mempool extends AggregateRoot {
  /* Tunables */
  private minFeeRate: number;
  private syncThresholdPercent = 0.9;

  /* Heuristic for mempool-info driven refresh after blocks */
  private mempoolInfoDriftTolerance = 0.15; // if |median(size) - ourTxCount| / max(1,median) > 15% → refresh
  private mempoolInfoMinProviders = 1; // minimal number of successful infos to consider heuristic

  /* Readiness flags */
  private isSynchronized = false; // flips to true exactly once per app run

  // simple timing memory for dynamic batching in processSync
  private prevSyncDurationMs = 0;
  private lastSyncDurationMs = 0;
  private currentBatchSize = 200;

  /* Internal stores */
  private txIndex = new TxIndex();
  private providerMap = new ProviderMap();
  private metaStore = new MetadataStore();
  private txStore = new TxStore();
  private loadTracker = new LoadTracker();

  constructor({
    aggregateId,
    blockHeight,
    minFeeRate = 1,
    options,
  }: {
    aggregateId: string;
    blockHeight: number;
    minFeeRate?: number;
    options?: { snapshotsEnabled?: boolean; allowPruning?: boolean; snapshotInterval?: number };
  }) {
    super(aggregateId, blockHeight, options);
    this.minFeeRate = minFeeRate;
  }

  /* ---------------------------- Snapshot serialize/restore ---------------------------- */
  protected serializeUserState(): Record<string, any> {
    return {
      minFeeRate: this.minFeeRate,
      syncThresholdPercent: this.syncThresholdPercent,
      isSynchronized: this.isSynchronized,
      mempoolInfoDriftTolerance: this.mempoolInfoDriftTolerance,

      txIndex_h2s: this.txIndex.__getMap(),
      provider_txToProviders: this.providerMap.__getMap(),
      provider_names: this.providerMap.__getNames(),
      metaStore_map: this.metaStore.__getMap(),
      txStore_map: this.txStore.__getMap(),
      loadTracker_map: this.loadTracker.__getMap(),
    };
  }

  protected restoreUserState(state: any): void {
    this.minFeeRate = typeof state?.minFeeRate === 'number' ? state.minFeeRate : 1;
    this.syncThresholdPercent = typeof state?.syncThresholdPercent === 'number' ? state.syncThresholdPercent : 0.9;
    this.isSynchronized = !!state?.isSynchronized;
    this.mempoolInfoDriftTolerance =
      typeof state?.mempoolInfoDriftTolerance === 'number' ? state.mempoolInfoDriftTolerance : 0.15;

    const toMap = <K, V>(m: any): Map<K, V> => (m instanceof Map ? m : Array.isArray(m) ? new Map(m) : new Map());
    const toMapOfSets = (m: any): Map<number, Set<number>> => {
      if (m instanceof Map) return m;
      const out = new Map<number, Set<number>>();
      if (Array.isArray(m)) {
        for (const [k, v] of m) out.set(k, v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
      }
      return out;
    };

    this.txIndex.__setMap(toMap<number, string>(state?.txIndex_h2s));
    this.providerMap.__setMap(toMapOfSets(state?.provider_txToProviders));
    this.providerMap.__setNames(Array.isArray(state?.provider_names) ? state.provider_names : []);
    this.metaStore.__setMap(toMap<number, MempoolTxMetadata>(state?.metaStore_map));
    this.txStore.__setMap(toMap<number, MempoolTransaction>(state?.txStore_map));
    this.loadTracker.__setMap(toMap<number, any>(state?.loadTracker_map));

    Object.setPrototypeOf(this, Mempool.prototype);
  }

  /* ----------------------------------- Helpers ----------------------------------- */
  private calcMetaFeeRate(m: MempoolTxMetadata): number {
    return m.vsize > 0 ? m.fee / m.vsize : 0;
  }
  private calcSlimFeeRate(t: MempoolTransaction): number {
    return t.vsize > 0 && t.fee !== undefined ? t.fee / t.vsize : 0;
  }

  private removeEverywhere(txHash: number): void {
    this.metaStore.remove(txHash);
    this.txStore.remove(txHash);
    this.loadTracker.remove(txHash);
    this.providerMap.remove(txHash);
    this.txIndex.removeByHash(txHash);
  }

  private async refreshFromVerboseSnapshot({
    requestId,
    height,
    service,
    logger,
    isSynchronized = true,
  }: {
    requestId: string;
    height: number;
    service: BlockchainProviderService;
    logger: Logger;
    isSynchronized?: boolean;
  }) {
    const verboseList = await service.getRawMempoolFromAll(true);

    if (verboseList.length === 0) {
      logger?.warn('Mempool metadata list is empty');
    }

    const uniqueTxids = new Set<string>();
    const providerTxMap = new Map<string, number[]>();
    const filteredMetaByTxid = new Map<string, MempoolTxMetadata>();

    for (let i = 0; i < verboseList.length; i++) {
      const obj = verboseList[i];
      if (!obj || typeof obj !== 'object') continue;

      const providerIndex = this.providerMap.getOrCreateProviderIndex(`provider_${i}`);

      for (const [txid, meta] of Object.entries(obj)) {
        uniqueTxids.add(txid);

        const arr = providerTxMap.get(txid) ?? [];
        arr.push(providerIndex);
        providerTxMap.set(txid, arr);

        const m = meta as MempoolTxMetadata;
        if (this.calcMetaFeeRate(m) >= this.minFeeRate) filteredMetaByTxid.set(txid, m);
      }
    }

    this.apply(
      new BitcoinMempoolInitializedEvent(
        { aggregateId: this.aggregateId, requestId, blockHeight: height },
        {
          allTxidsFromNode: Array.from(uniqueTxids),
          providerTxidMapping: Object.fromEntries(providerTxMap),
          aggregatedMetadata: Object.fromEntries(filteredMetaByTxid),
          isSynchronized,
        }
      )
    );
  }

  /* ----------------------------------- Commands ----------------------------------- */

  /**
   * Initialize: single verbose=true pass across providers, dedupe, fee-filter metadata, build provider map.
   * Complexity: O(T) over total txids; memory: ~10–25MB per 50k entries.
   */
  public async init({
    requestId,
    currentNetworkHeight,
    service,
    logger,
  }: {
    requestId: string;
    currentNetworkHeight: number;
    service: BlockchainProviderService;
    logger: Logger;
  }) {
    return this.refreshFromVerboseSnapshot({
      isSynchronized: false,
      requestId,
      height: currentNetworkHeight,
      service,
      logger,
    });
  }

  /**
   * Synchronize by loading slimmed full txs ONLY for not-yet-loaded, high-fee txids.
   * Plan:
   *  - Gather txids present in MetadataStore but not in LoadTracker.
   *  - Group by providerIndex (first provider who saw the tx), without fallback.
   *  - For each provider run ONE batch request in parallel.
   *  - Normalize each Transaction → MempoolTransaction and store.
   *  - Adapt currentBatchSize based on wall-clock duration vs previous cycle.
   *
   * Complexity: planning O(T), network dominated by RPC batch; memory: ~1–1.5MB per 200 tx (after slimming).
   */
  public async processSync({
    requestId,
    service,
    hasMoreToProcess = true,
  }: {
    requestId: string;
    service: BlockchainProviderService;
    hasMoreToProcess?: boolean;
  }) {
    if (!hasMoreToProcess) return;

    // progress gate (when metadata exists but we haven't loaded enough "slim txs" yet)
    if (!this.isSynchronized) {
      const expected = this.metaStore.size();
      const loaded = this.loadTracker.count();
      const p = expected > 0 ? loaded / expected : 0;
      if (p === 0 || p >= this.syncThresholdPercent) {
        this.apply(
          new BitcoinMempoolSynchronizedEvent(
            { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
            { isSynchronized: true }
          )
        );
        return;
      }
    }

    // compute list of txids to load (not loaded yet; and must be high-fee because metaStore was filtered in init)
    const candidates: string[] = [];
    for (const [txHash] of this.metaStore.entries()) {
      if (this.loadTracker.isLoaded(txHash)) continue;
      const txid = this.txIndex.getByHash(txHash);
      if (txid) candidates.push(txid);
      if (candidates.length >= this.currentBatchSize * 2) break; // small overhead for better distribution
    }
    if (candidates.length === 0) return;

    // apply global batch limit (single number)
    const batchTxids = candidates.slice(0, this.currentBatchSize);

    // group by provider (no fallback)
    const plan = planBatchesByProvider(batchTxids, this.providerMap, this.currentBatchSize);

    // --- timing start
    const syncStart = Date.now();

    // parallel requests per provider
    const tasks: Promise<void>[] = [];
    const loadedForEvent: Array<{ txid: string; transaction: MempoolTransaction; providerIndex: number }> = [];

    for (const [providerIndex, txids] of plan.entries()) {
      const providerName = this.providerMap.getProviderName(providerIndex);
      if (!providerName || txids.length === 0) continue;

      tasks.push(
        (async () => {
          // getrawtransaction in batch; no fallback; whatever arrives is used
          const txs = await service.getMempoolTransactionsByTxids(txids, true, 1, {
            strategy: 'single',
            providerName,
          });

          // align by position: service preserves input order; nulls may appear for misses
          for (let i = 0; i < txids.length; i++) {
            const txid = txids[i]!;
            const full = txs[i];
            if (!full) continue;

            const slim = normalizeToMempoolTx(full);
            loadedForEvent.push({ txid, transaction: slim, providerIndex });
          }
        })()
      );
    }

    await Promise.allSettled(tasks);

    // --- timing end + dynamic batch adaptation
    const duration = Date.now() - syncStart;
    this.prevSyncDurationMs = this.lastSyncDurationMs || duration;
    this.lastSyncDurationMs = duration;

    const ratio = this.lastSyncDurationMs / (this.prevSyncDurationMs || this.lastSyncDurationMs);
    if (ratio > 1.2) {
      // took significantly longer → reduce by 25%
      this.currentBatchSize = Math.max(1, Math.round(this.currentBatchSize * 0.75));
    } else if (ratio < 0.8) {
      // significantly faster → increase by 25%
      this.currentBatchSize = Math.max(1, Math.round(this.currentBatchSize * 1.25));
    }
    // else keep as is

    const hasMore = candidates.length > this.currentBatchSize;

    this.apply(
      new BitcoinMempoolSyncProcessedEvent(
        { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
        { loadedTransactions: loadedForEvent, hasMoreToProcess: hasMore }
      )
    );
  }

  /**
   * Blocks batch:
   * 1) Remove confirmed tx locally (cheap, O(K)).
   * 2) Consult mempool info across providers (median size). If our snapshot drifted beyond tolerance,
   *    refresh verbose snapshot (single verbose=true pass) to realign and then continue normal syncing.
   */
  public async processBlocksBatch({
    requestId,
    blocks,
    service,
    logger,
  }: {
    requestId: string;
    blocks: LightBlock[];
    service: BlockchainProviderService;
    logger: Logger;
  }) {
    // (1) local removal
    const toRemove: string[] = [];
    for (const b of blocks) {
      if (!b?.tx) continue;
      for (const txid of b.tx) if (typeof txid === 'string') toRemove.push(txid);
    }
    if (toRemove.length) {
      this.apply(
        new BitcoinMempoolBlockBatchProcessedEvent(
          {
            aggregateId: this.aggregateId,
            requestId,
            blockHeight:
              blocks.length > 0 ? blocks[blocks.length - 1]?.height ?? this.lastBlockHeight : this.lastBlockHeight,
          },
          { txidsToRemove: toRemove }
        )
      );
    }

    // (2) mempool info heuristic (multi-provider)
    //    - We compare our txIndex.size() (total txids we currently track) to the median(node.size).
    //    - If |median - ours| / max(1, median) > tolerance => refresh verbose snapshot.
    //    - Reason: a block may also evict/accept many non-tracked or new tx; our local removals
    //      only touch confirmed. A large drift signals we are stale (new txs or evicted ones).
    const infos = await service.getMempoolInfoFromAll().catch(() => []);
    const sizes: number[] = [];
    for (const i of infos as any[]) {
      if (i && typeof i.size === 'number' && i.size >= 0) sizes.push(i.size);
    }
    if (sizes.length >= this.mempoolInfoMinProviders) {
      sizes.sort((a, b) => a - b);
      const mid = Math.floor(sizes.length / 2);
      const median = sizes.length % 2 ? sizes[mid]! : Math.floor((sizes[mid - 1]! + sizes[mid]!) / 2);
      const ours = this.txIndex.size();
      const drift = Math.abs(median - ours) / Math.max(1, median);

      if (drift > this.mempoolInfoDriftTolerance) {
        // Refresh snapshot to align with network view (single verbose=true pass).
        return this.refreshFromVerboseSnapshot({
          requestId,
          height: this.lastBlockHeight,
          service,
          logger,
        });
      }
    }
  }

  /**
   * Reorganization handling:
   *  - Fetch fresh verbose snapshot (true) for all providers (single round).
   *  - Rebuild provider mapping & metadata but **preserve already loaded slim tx**
   *    for txids that are still in the new snapshot.
   *  - Remove everything else immediately to free memory.
   *
   * Complexity: same as init(); memory: same as init(); IO: O(Np) calls.
   */
  public async processReorganisation({
    requestId,
    reorgHeight,
    service,
    logger,
  }: {
    requestId: string;
    reorgHeight: number;
    service: BlockchainProviderService;
    logger: Logger;
  }) {
    return this.refreshFromVerboseSnapshot({
      requestId,
      height: reorgHeight,
      service,
      logger,
    });
  }

  /** Clear all mempool state (idempotent). */
  public async clearMempool({ requestId }: { requestId: string }) {
    this.apply(new BitcoinMempoolClearedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: -1 }, {}));
  }

  /* ------------------------------ Event handlers ------------------------------ */
  private onBitcoinMempoolInitializedEvent({ payload }: BitcoinMempoolInitializedEvent) {
    const { allTxidsFromNode, isSynchronized, providerTxidMapping, aggregatedMetadata } = payload;

    const newTxIndex = new TxIndex();
    const newMeta = new MetadataStore();
    const newProviders = new ProviderMap();

    // keep provider names order if we had one
    newProviders.__setNames(this.providerMap.getProviderNames());

    for (const txid of allTxidsFromNode) {
      const h = newTxIndex.add(txid);
      const m = aggregatedMetadata?.[txid];
      if (m) newMeta.set(h, m as MempoolTxMetadata);
      const provArr = providerTxidMapping?.[txid];
      if (Array.isArray(provArr)) for (const idx of provArr) newProviders.add(h, idx);
    }

    // drop tx that disappeared; keep slim where tx still exists
    const newHashes = new Set<number>(newTxIndex.keys());
    for (const oldHash of this.txIndex.keys()) if (!newHashes.has(oldHash)) this.removeEverywhere(oldHash);

    this.txIndex = newTxIndex;
    this.metaStore = newMeta;
    this.providerMap = newProviders;

    if (isSynchronized === false) this.isSynchronized = false;
  }

  private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
    const { loadedTransactions } = payload;
    for (const { txid, transaction, providerIndex } of loadedTransactions) {
      const h = hashTxid32(txid);
      this.txStore.put(h, transaction);
      const fr = this.calcSlimFeeRate(transaction);
      this.loadTracker.mark(h, { timestamp: Date.now(), feeRate: fr, providerIndex: providerIndex ?? 0 });
      if (!this.txIndex.hasHash(h)) this.txIndex.add(txid);
      if (providerIndex !== undefined) this.providerMap.add(h, providerIndex);
    }
  }

  private onBitcoinMempoolSynchronizedEvent({ payload }: BitcoinMempoolSynchronizedEvent) {
    this.isSynchronized = !!payload.isSynchronized;
  }

  private onBitcoinMempoolBlockBatchProcessedEvent({ payload }: BitcoinMempoolBlockBatchProcessedEvent) {
    const { txidsToRemove } = payload;
    if (txidsToRemove && Array.isArray(txidsToRemove)) {
      for (const txid of txidsToRemove) {
        const h = hashTxid32(txid);
        if (this.txIndex.hasHash(h)) this.removeEverywhere(h);
      }
    } else {
      this.txIndex.clear();
      this.metaStore.clear();
      this.txStore.clear();
      this.loadTracker.clear();
      this.providerMap.clear();
    }
  }

  private onBitcoinMempoolClearedEvent(_: BitcoinMempoolClearedEvent) {
    this.txIndex.clear();
    this.metaStore.clear();
    this.txStore.clear();
    this.loadTracker.clear();
    this.providerMap.clear();
    this.isSynchronized = false;
    this.currentBatchSize = 200;
    this.prevSyncDurationMs = 0;
    this.lastSyncDurationMs = 0;
  }

  // ======= Read API =========================================================

  /** O(n) – returns all txids currently tracked. */
  public getCurrentTxids(): string[] {
    return Array.from(this.txIndex.values());
  }

  /** O(1) – get metadata for txid if present. */
  public getTransactionMetadata(txid: string): MempoolTxMetadata | undefined {
    return this.metaStore.get(hashTxid32(txid));
  }

  /** O(1) – get slim transaction (MempoolTransaction) for txid. */
  public getFullTransaction(txid: string): MempoolTransaction | undefined {
    return this.txStore.get(hashTxid32(txid));
  }

  /** O(1) – existence check. */
  public hasTransaction(txid: string): boolean {
    return this.txIndex.hasHash(hashTxid32(txid));
  }

  /** O(1) – whether slim tx already loaded. */
  public isTransactionLoaded(txid: string): boolean {
    return this.loadTracker.isLoaded(hashTxid32(txid));
  }

  /** O(p) – list provider names that reported this tx. */
  public getProvidersForTransaction(txid: string): string[] {
    const set = this.providerMap.getProviders(hashTxid32(txid));
    if (!set) return [];
    const out: string[] = [];
    for (const idx of set) {
      const name = this.providerMap.getProviderName(idx);
      if (name) out.push(name);
    }
    return out;
  }

  /** O(n) – collect txids by feeRate threshold using metadata (fast, cheap). */
  public getTransactionsAboveFeeRate(minFeeRate: number): string[] {
    const out: string[] = [];
    for (const [h, m] of this.metaStore.entries()) {
      if (this.calcMetaFeeRate(m) >= minFeeRate) {
        const txid = this.txIndex.getByHash(h);
        if (txid) out.push(txid);
      }
    }
    return out;
  }

  /** O(n) – return txs with feeRate in [min, max], sorted desc by feeRate. */
  public getTransactionsByFeeRateRange(
    minFeeRate: number,
    maxFeeRate: number
  ): Array<{ txid: string; feeRate: number; metadata: MempoolTxMetadata; slim?: MempoolTransaction }> {
    const res: Array<{ txid: string; feeRate: number; metadata: MempoolTxMetadata; slim?: MempoolTransaction }> = [];
    for (const [h, m] of this.metaStore.entries()) {
      const fr = this.calcMetaFeeRate(m);
      if (fr >= minFeeRate && fr <= maxFeeRate) {
        const txid = this.txIndex.getByHash(h);
        if (!txid) continue;
        res.push({ txid, feeRate: fr, metadata: m, slim: this.txStore.get(h) });
      }
    }
    return res.sort((a, b) => b.feeRate - a.feeRate);
  }

  /** O(n log n) – top N by feeRate using metadata. */
  public getTopTransactionsByFeeRate(limit = 100) {
    return this.getTransactionsByFeeRateRange(0, Infinity).slice(0, limit);
  }

  /** O(1) – rough memory estimate for telemetry/monitoring. */
  public getMempoolSize() {
    const txidCount = this.txIndex.size();
    const metadataCount = this.metaStore.size();
    const slimCount = this.txStore.count();

    const txidMappings = txidCount * 72; // 4B hash + 64B txid (+overhead)
    const metadataBytes = metadataCount * 350; // ~350B avg
    const slimBytes = slimCount * 2000; // ~2KB avg slim tx (conservative)
    const providerMapBytes = txidCount * 20;

    return {
      txidCount,
      metadataCount,
      fullTransactionCount: slimCount,
      estimatedMemoryUsage: {
        txidMappings,
        metadata: metadataBytes,
        fullTransactions: slimBytes,
        providerMappings: providerMapBytes,
        total: txidMappings + metadataBytes + slimBytes + providerMapBytes,
      },
    };
  }

  /** O(n) – aggregated statistics. */
  public getMempoolStats() {
    const totalTxids = this.txIndex.size();
    const loadedFull = this.txStore.count();
    const loaded = this.loadTracker.count();
    const expected = this.metaStore.size();
    const syncProgress = expected > 0 ? loaded / expected : 0;

    // compute average/median from metadata
    const rates: number[] = [];
    for (const [, m] of this.metaStore.entries()) rates.push(this.calcMetaFeeRate(m));
    const averageFeeRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    let medianFeeRate = 0;
    if (rates.length) {
      rates.sort((a, b) => a - b);
      const mid = Math.floor(rates.length / 2);
      medianFeeRate = rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
    }

    return {
      totalTxids,
      loadedMetadata: expected,
      loadedFullTransactions: loadedFull,
      syncProgress,
      averageFeeRate,
      medianFeeRate,
      totalProviders: this.providerMap.getProviderNames().length,
    };
  }

  /** O(n) – ready transactions (slimmed) sorted by feeRate desc. */
  public getReadyTransactions(): Array<{
    txid: string;
    transaction: MempoolTransaction;
    metadata: MempoolTxMetadata;
    feeRate: number;
    loadedAt: number;
    providerIndex: number;
  }> {
    const out: Array<{
      txid: string;
      transaction: MempoolTransaction;
      metadata: MempoolTxMetadata;
      feeRate: number;
      loadedAt: number;
      providerIndex: number;
    }> = [];

    for (const [h, info] of this.loadTracker.__getMap()) {
      const txid = this.txIndex.getByHash(h);
      const slim = this.txStore.get(h);
      const meta = this.metaStore.get(h);
      if (!txid || !slim || !meta) continue;
      out.push({
        txid,
        transaction: slim,
        metadata: meta,
        feeRate: info.feeRate,
        loadedAt: info.timestamp,
        providerIndex: info.providerIndex,
      });
    }
    return out.sort((a, b) => b.feeRate - a.feeRate);
  }

  /** O(1) */
  public getSyncProgress() {
    const totalExpected = this.metaStore.size();
    const loaded = this.loadTracker.count();
    const remaining = Math.max(0, totalExpected - loaded);
    const progress = totalExpected > 0 ? loaded / totalExpected : 0;
    return { progress, totalExpected, loaded, remaining };
  }

  /** O(1) */
  public getProviderNames(): string[] {
    return this.providerMap.getProviderNames();
  }
}
