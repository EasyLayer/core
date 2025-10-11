import type { Logger } from '@nestjs/common';
import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, Transaction, MempoolTxMetadata } from '../../../blockchain-provider';
import {
  BitcoinMempoolInitializedEvent,
  BitcoinMempoolSyncProcessedEvent,
  BitcoinMempoolClearedEvent,
  BitcoinMempoolSynchronizedEvent,
  BitcoinMempoolBlockBatchProcessedEvent,
} from '../../events';
import { hashTxid32, TxIndex, ProviderMap, MetadataStore, TxStore, LoadTracker } from './components';
import type { LightBlock, LightTransaction, LightVin, LightVout } from '../interfaces';

/** === BatchPlanner (stateless util) ========================================
 * Responsibility: group txids by providerIndex; optionally slice to total limit.
 * Complexity: O(n), memory: proportional to #txids.
 */
function planBatchesByProvider(
  txids: string[],
  providers: ProviderMap,
  perProviderCaps: Map<number, number>
): Map<number, string[]> {
  const plan = new Map<number, string[]>();
  if (txids.length === 0) return plan;

  const takenByProvider = new Map<number, number>();

  for (const txid of txids) {
    const h = hashTxid32(txid);
    const primary = providers.primaryProviderIndex(h);
    if (primary == null) continue;

    const cap = perProviderCaps.get(primary) ?? 0;
    if (cap <= 0) continue;

    const taken = takenByProvider.get(primary) ?? 0;
    if (taken >= cap) continue;

    let arr = plan.get(primary);
    if (!arr) plan.set(primary, (arr = []));
    arr.push(txid);
    takenByProvider.set(primary, taken + 1);
  }

  return plan;
}

/**
 * Slimming normalizer:
 * Convert heavy Transaction → MempoolTransaction immediately (omit large fields, keep only what's needed).
 * Complexity: O(#vin + #vout)
 */
function normalizeToMempoolTx(tx: Transaction): LightTransaction {
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

  const slim: LightTransaction = {
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

  // Per-provider batching (in-memory only; not serialized)
  private defaultPerProviderBatchSize = 200;
  private perProviderBatch = new Map<number, number>();
  private __prevDur?: Map<number, number>; // previous durations per provider (ms), also in-memory only

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
    this.defaultPerProviderBatchSize = 200;

    const toMap = <K, V>(m: any): Map<K, V> => (m instanceof Map ? m : Array.isArray(m) ? new Map(m) : new Map());
    const toMapOfSets = (m: any): Map<number, Set<number>> => {
      if (m instanceof Map) return m;
      const out = new Map<number, Set<number>>();
      if (Array.isArray(m)) {
        for (const [k, v] of m) out.set(k, v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
      }
      return out;
    };

    // re-create instances before applying internal maps
    this.txIndex = new TxIndex();
    this.providerMap = new ProviderMap();
    this.metaStore = new MetadataStore();
    this.txStore = new TxStore();
    this.loadTracker = new LoadTracker();

    this.txIndex.__setMap(toMap<number, string>(state?.txIndex_h2s));
    this.providerMap.__setMap(toMapOfSets(state?.provider_txToProviders));
    this.providerMap.__setNames(Array.isArray(state?.provider_names) ? state.provider_names : []);
    this.metaStore.__setMap(toMap<number, MempoolTxMetadata>(state?.metaStore_map));
    this.txStore.__setMap(toMap<number, LightTransaction>(state?.txStore_map));
    this.loadTracker.__setMap(toMap<number, any>(state?.loadTracker_map));

    Object.setPrototypeOf(this, Mempool.prototype);
  }

  /* ----------------------------------- Helpers ----------------------------------- */
  private calcMetaFeeRate(m: MempoolTxMetadata): number {
    return m.vsize > 0 ? m.fee / m.vsize : 0;
  }
  private calcSlimFeeRate(t: LightTransaction): number {
    return t.vsize > 0 && t.fee !== undefined ? t.fee / t.vsize : 0;
  }

  // ===== helpers: robust fee/feerate from verbose mempool meta =====

  /** Extract fee (in sats) from verbose mempool metadata. */
  private feeSatsFromMeta(m: MempoolTxMetadata): number {
    const any = m as any;

    // Some nodes expose flat `fee` (BTC) or already in sats (large numbers) — handle both.
    if (typeof any.fee === 'number') {
      // Heuristic: if value is huge it's likely already in sats; otherwise BTC.
      return any.fee > 1e3 ? Math.round(any.fee) : Math.round(any.fee * 1e8);
    }

    // Bitcoin Core typical shape: fees.{base|modified|ancestor|descendant} in BTC
    const fees = any.fees;
    if (fees && typeof fees === 'object') {
      const cand =
        (typeof fees.modified === 'number' && fees.modified) ??
        (typeof fees.base === 'number' && fees.base) ??
        (typeof fees.ancestor === 'number' && fees.ancestor) ??
        (typeof fees.descendant === 'number' && fees.descendant) ??
        0;
      return Math.round(cand * 1e8);
    }

    return 0;
  }

  /** Compute fee rate (sat/vB) from verbose mempool metadata; returns NaN if impossible. */
  private calcMetaFeeRateRobust(m: MempoolTxMetadata): number {
    const any = m as any;
    const vsize = Number(any.vsize);
    if (!Number.isFinite(vsize) || vsize <= 0) return NaN;

    const sats = this.feeSatsFromMeta(m);
    if (!Number.isFinite(sats) || sats < 0) return NaN;

    return sats / vsize;
  }

  private removeEverywhere(txHash: number): void {
    this.metaStore.remove(txHash);
    this.txStore.remove(txHash);
    this.loadTracker.remove(txHash);
    this.providerMap.remove(txHash);
    this.txIndex.removeByHash(txHash);
  }

  /** Lazy getter: returns current batch size for provider, initializes with default if absent */
  private getBatchSizeFor(providerIndex: number): number {
    let v = this.perProviderBatch.get(providerIndex);
    if (!v || v <= 0) {
      v = this.defaultPerProviderBatchSize;
      this.perProviderBatch.set(providerIndex, v);
    }
    return v;
  }

  /** Simple adaptive tuning per provider based on ratio (currentDuration / previousDuration) */
  private tuneBatchSize(providerIndex: number, ratio: number) {
    let v = this.getBatchSizeFor(providerIndex);
    if (ratio > 1.2) {
      v = Math.max(1, Math.round(v * 0.75)); // slower => shrink
    } else if (ratio < 0.8) {
      v = Math.max(1, Math.round(v * 1.25)); // faster => grow
    }
    this.perProviderBatch.set(providerIndex, v);
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
    const result = await service.getRawMempoolFromAll(true);

    if (result.length === 0) {
      logger?.warn('Mempool metadata list is empty');
    }

    const uniqueTxids = new Set<string>();
    const providerTxMap = new Map<string, number[]>();
    const filteredMetaByTxid = new Map<string, MempoolTxMetadata>();

    for (const { providerName, value } of result) {
      const idx = this.providerMap.getIndexByName(providerName);
      if (idx == null) {
        logger.debug('refreshFromVerboseSnapshot: got response from unknown provider, skipping', {
          args: { providerName },
        });
        continue;
      }
      if (!value || typeof value !== 'object') continue;

      for (const [txid, meta] of Object.entries(value)) {
        uniqueTxids.add(txid);

        const arr = providerTxMap.get(txid) ?? [];
        arr.push(idx);
        providerTxMap.set(txid, arr);

        const m = meta as MempoolTxMetadata;

        // --- robust feeRate (sat/vB)
        let fr = this.calcMetaFeeRateRobust(m);
        if (!Number.isFinite(fr)) {
          logger?.debug?.('refreshFromVerboseSnapshot: invalid feeRate from metadata; treating as 0', {
            args: {
              txid,
              vsize: (m as any)?.vsize,
              feeShape: typeof (m as any)?.fee === 'number' ? 'fee:number' : (m as any)?.fees ? 'fees.object' : 'none',
            },
          });
          fr = 0;
        }

        if (fr >= this.minFeeRate) {
          filteredMetaByTxid.set(txid, m);
        }
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

    logger.log('Mempool refreshed', {
      args: {
        mempoolSize: this.getMempoolSize(),
      },
    });
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
    const providersNewNames = service.getAllMempoolProviderNames();
    if (!Array.isArray(providersNewNames) || providersNewNames.length === 0) {
      throw new Error('No mempool providers configured');
    }

    const oldNames = this.providerMap.getProviderNames();

    if (this.providerMap.hasSameNames(providersNewNames)) {
      // The composition hasn't changed - we'll leave it as is
    } else if (oldNames.length === 0) {
      // first initialization after empty state
      this.providerMap.setNamesOnce(providersNewNames);
    } else {
      // composition/order changed - replace names and clear visibility map
      this.providerMap.replaceNames(providersNewNames);

      // The indexes have changed → batch tuning is no longer valid
      this.perProviderBatch.clear();
      this.__prevDur = undefined;
    }

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
   *  - Group by providerIndex (first/primary provider who saw the tx), without fallback.
   *  - For each provider run ONE batch request in parallel.
   *  - Normalize each Transaction → MempoolTransaction and store.
   *  - Adapt per-provider batch size based on wall-clock duration vs previous cycle (per provider).
   *
   * Complexity: planning O(T), network dominated by RPC batch; memory: ~1–1.5MB per 200 tx (after slimming).
   */
  public async processSync({
    requestId,
    service,
    logger,
    hasMoreToProcess = true,
  }: {
    requestId: string;
    service: BlockchainProviderService;
    logger: Logger;
    hasMoreToProcess?: boolean;
  }) {
    if (!hasMoreToProcess) return;

    // progress gate (when metadata exists but we haven't loaded enough "slim txs" yet)
    if (!this.isSynchronized) {
      const expected = this.metaStore.size();
      const loaded = this.loadTracker.count();
      const p = expected > 0 ? loaded / expected : 0;
      if (p >= this.syncThresholdPercent) {
        this.apply(
          new BitcoinMempoolSynchronizedEvent(
            { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
            { isSynchronized: true }
          )
        );
        return;
      }
    }

    // === candidates: all txids with metadata but not yet slim-loaded (no duplicates) ===
    const candidates: string[] = [];
    for (const [txHash] of this.metaStore.entries()) {
      if (this.loadTracker.isLoaded(txHash)) continue;
      const txid = this.txIndex.getByHash(txHash);
      if (txid) candidates.push(txid);
    }
    if (candidates.length === 0) return;

    // === per-provider caps from adaptive batch sizes (lazy init) ===
    const perProviderCaps = new Map<number, number>();
    for (const idx of this.providerMap.providerIndices()) {
      perProviderCaps.set(idx, this.getBatchSizeFor(idx));
    }

    // === group by provider (no fallback); respect per-provider caps ===
    const plan = planBatchesByProvider(candidates, this.providerMap, perProviderCaps);

    if (plan.size === 0) {
      this.apply(
        new BitcoinMempoolSyncProcessedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          { loadedTransactions: [], hasMoreToProcess: false }
        )
      );
      return;
    }

    // --- parallel requests per provider with per-provider timing & adaptation
    const loadedBefore = this.loadTracker.count();
    const loadedForEvent: Array<{ txid: string; transaction: LightTransaction; providerIndex: number }> = [];
    const tasks: Promise<void>[] = [];
    const startedAt = new Map<number, number>();

    for (const [providerIndex, txids] of plan.entries()) {
      const providerName = this.providerMap.getProviderName(providerIndex);
      if (!providerName || txids.length === 0) continue;

      tasks.push(
        (async () => {
          try {
            startedAt.set(providerIndex, Date.now());

            // getrawtransaction in batch; no fallback; whatever arrives is used
            const txs = await service.getMempoolTransactionsByTxids(txids, true, 1, {
              strategy: 'single',
              providerName,
            });

            // NOTE: no positional alignment — just consume what arrived
            for (const full of txs) {
              if (!full?.txid) continue;
              const slim = normalizeToMempoolTx(full);
              loadedForEvent.push({ txid: slim.txid, transaction: slim, providerIndex });
            }
          } catch (e) {
            logger?.warn?.('processSync provider batch failed', {
              args: { providerName, error: (e as any)?.message ?? String(e) },
            });
          } finally {
            // adaptive per-provider batch tuning
            const start = startedAt.get(providerIndex)!;
            const duration = Date.now() - start;
            if (!this.__prevDur) this.__prevDur = new Map<number, number>();
            const prev = this.__prevDur.get(providerIndex) ?? duration;
            const ratio = duration / (prev || duration);
            this.__prevDur.set(providerIndex, duration);
            this.tuneBatchSize(providerIndex, ratio);
          }
        })()
      );
    }

    await Promise.allSettled(tasks);

    // hasMore: compare "how much was downloaded" + "how much has been downloaded now" with the expected amount
    const expected = this.metaStore.size();
    const loadedThisCycle = loadedForEvent.length;
    const hasMore = loadedThisCycle > 0 && loadedBefore + loadedThisCycle < expected;

    this.apply(
      new BitcoinMempoolSyncProcessedEvent(
        { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
        { loadedTransactions: loadedForEvent, hasMoreToProcess: hasMore }
      )
    );

    logger.log('Mempool sync processing', {
      args: {
        mempoolSize: this.getMempoolSize(),
      },
    });
  }

  /**
   * Blocks batch:
   * 1) Remove confirmed tx locally (cheap, O(K)).
   * 2) Heuristic: query mempool info from providers, compare our tracked count vs median(node.size).
   *    If drift exceeds tolerance → refresh verbose snapshot to realign.
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

      logger.log('Mempool blocks batch processed successfully', {
        args: { mempoolSize: this.getMempoolSize() },
      });
    }

    // (2) mempool info heuristic
    // service.getMempoolInfoFromAll() may return:
    //   - Array<MempoolInfo>
    //   - OR Array<{ providerName: string; value: MempoolInfo }>
    // Be tolerant to both shapes and to partial failures.
    let infos: any[] = [];
    try {
      infos = await service.getMempoolInfoFromAll();
    } catch (e) {
      logger.warn('processBlocksBatch: mempool info fetch failed', {
        args: { error: (e as any)?.message ?? String(e) },
      });
      return; // no heuristic possible
    }

    const sizes: number[] = [];
    for (const item of infos) {
      const val = item && typeof item === 'object' && 'value' in item ? (item as any).value : item;
      const sz = val?.size;
      if (typeof sz === 'number' && sz >= 0) sizes.push(sz);
    }

    if (sizes.length >= this.mempoolInfoMinProviders) {
      sizes.sort((a, b) => a - b);
      const mid = Math.floor(sizes.length / 2);
      const median = sizes.length % 2 ? sizes[mid]! : Math.floor((sizes[mid - 1]! + sizes[mid]!) / 2);
      const ours = this.txIndex.size();
      const drift = Math.abs(median - ours) / Math.max(1, median);

      if (drift > this.mempoolInfoDriftTolerance) {
        await this.refreshFromVerboseSnapshot({
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
      if (Array.isArray(provArr) && provArr.length > 0) {
        newProviders.setProvidersForTx(
          h,
          provArr.filter((i) => typeof i === 'number')
        );
      }
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
      if (providerIndex !== undefined) {
        // do NOT change visibility map here; it's maintained by snapshots
      }
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
      // keep provider names; clear() in ProviderMap does not drop names
    }
  }

  private onBitcoinMempoolClearedEvent(_: BitcoinMempoolClearedEvent) {
    this.txIndex.clear();
    this.metaStore.clear();
    this.txStore.clear();
    this.loadTracker.clear();
    this.providerMap.clear();
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
  public getFullTransaction(txid: string): LightTransaction | undefined {
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
      const fr = this.calcMetaFeeRateRobust(m);
      if (Number.isFinite(fr) && fr >= minFeeRate) {
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
  ): Array<{ txid: string; feeRate: number; metadata: MempoolTxMetadata; slim?: LightTransaction }> {
    const res: Array<{ txid: string; feeRate: number; metadata: MempoolTxMetadata; slim?: LightTransaction }> = [];
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
    transaction: LightTransaction;
    metadata: MempoolTxMetadata;
    feeRate: number;
    loadedAt: number;
    providerIndex: number;
  }> {
    const out: Array<{
      txid: string;
      transaction: LightTransaction;
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
