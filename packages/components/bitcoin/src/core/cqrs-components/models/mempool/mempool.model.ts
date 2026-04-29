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
import { createMempoolStateStore } from './mempool-state.store';
import type { LightTransaction, LightVin, LightVout } from '../interfaces';
import type { MempoolStateStore } from '../../../native';

export type ProviderSnapshot = Record<
  string, // provider name
  Array<{ txid: string; metadata: MempoolTxMetadata }>
>;

/** === BatchSizer (per‑provider adaptive logic) ==============================
 * Maintains per‑provider batch sizes and adapts using last duration ratio.
 * Complexity: O(1) updates.
 */
export class BatchSizer {
  private sizeByProvider = new Map<string, number>();
  private defaultSize: number;
  private minSize: number;
  private maxSize: number;

  constructor(defaultSize = 200, minSize = 20, maxSize = 2000) {
    this.defaultSize = defaultSize;
    this.minSize = minSize;
    this.maxSize = maxSize;
  }

  get(provider: string): number {
    const v = this.sizeByProvider.get(provider);
    if (!v || v <= 0) {
      this.sizeByProvider.set(provider, this.defaultSize);
      return this.defaultSize;
    }
    return v;
  }

  /** Update using ratio = currentDurationMs / previousDurationMs */
  tune(provider: string, ratio: number) {
    let v = this.get(provider);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    if (ratio > 1.25)
      v = Math.max(this.minSize, Math.round(v * 0.8)); // slower -> shrink
    else if (ratio < 0.8) v = Math.min(this.maxSize, Math.round(v * 1.2)); // faster -> grow
    this.sizeByProvider.set(provider, v);
  }

  clear() {
    this.sizeByProvider.clear();
  }
}

/**
 * Event-sourced mempool aggregate.
 *
 * Persistent state is delegated to a compact store implementation:
 * - Node runtime: Rust N-API store when the native binary is available.
 * - Browser/test/runtime fallback: JS handle-based store with the same public behavior.
 *
 * State changes still happen only via event handlers. Provider RPC loading remains in TS.
 */
export class Mempool extends AggregateRoot {
  private minFeeRate: number; // sats/vB filter for metadata
  private batchSizer = new BatchSizer(500, 50, 10_000);
  private prevDuration: Map<string, number> | undefined;
  private store: MempoolStateStore = createMempoolStateStore();

  private lastUpdatedMs = Date.now();

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
              address: o.scriptPubKey.address,
              addresses: o.scriptPubKey.addresses,
              hex: o.scriptPubKey.hex,
            }
          : undefined,
      })
    );

    const feeRate =
      typeof full.feeRate === 'number' && Number.isFinite(full.feeRate)
        ? full.feeRate
        : typeof full.fee === 'number' &&
            Number.isFinite(full.fee) &&
            typeof full.vsize === 'number' &&
            Number.isFinite(full.vsize) &&
            full.vsize > 0
          ? full.fee / full.vsize
          : undefined;

    const lightTransaction: LightTransaction = {
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
    };

    if (feeRate !== undefined) {
      lightTransaction.feeRate = feeRate;
    }

    return lightTransaction;
  }

  /* ---------------------------- Snapshot serialize/restore ---------------------------- */
  protected serializeUserState(): Record<string, any> {
    return {
      minFeeRate: this.minFeeRate,
      mempoolStore: this.store.exportSnapshot(),
    };
  }

  protected restoreUserState(state: any): void {
    this.minFeeRate = typeof state?.minFeeRate === 'number' ? state.minFeeRate : 1;

    this.batchSizer = new BatchSizer(500, 50, 10_000);
    this.prevDuration = undefined;
    this.store = createMempoolStateStore();
    this.store.importSnapshot(state?.mempoolStore ?? state);

    Object.setPrototypeOf(this, Mempool.prototype);
  }

  // ====================================================================================
  // Commands (no state mutation here!)
  // ====================================================================================

  /** App startup: open the initial-sync window and signal the system to begin. */
  public async init({ requestId, height, logger }: { requestId: string; height: number; logger: Logger }) {
    this.apply(
      new BitcoinMempoolInitializedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: height }, {})
    );

    logger.log('Mempool successfully initialized', {
      module: 'mempool-model',
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
    logger.log('Mempool refreshed', { module: 'mempool-model' });
  }

  /**
   * One sync tick.
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
    const byProvider = new Map<string, string[]>();

    for (const provider of this.store.providers()) {
      const size = this.batchSizer.get(provider);
      const pending = this.store.pendingTxids(provider, size);
      if (pending.length > 0) byProvider.set(provider, pending);
    }

    if (byProvider.size === 0) {
      this.apply(
        new BitcoinMempoolSynchronizedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          {}
        )
      );

      logger.log('Mempool synced', {
        module: 'mempool-model',
        args: { mempool: this.getMemoryUsage() },
      });

      return;
    }

    const loadedForEvent: Array<{
      txid: string;
      transaction: LightTransaction;
      providerName?: string;
    }> = [];
    const batchDurations: Record<string, number> = {};

    const startedAt = new Map<string, number>();
    const tasks = Array.from(byProvider.entries()).map(([providerName, slice]) =>
      (async () => {
        if (slice.length === 0) return;

        try {
          startedAt.set(providerName, Date.now());
          const txs = await service.getMempoolTransactionsByTxids(slice, true, 1, {
            strategy: 'single',
            providerName,
          });

          const got = new Map<string, Transaction>();
          for (const t of txs) if (t?.txid) got.set(t.txid, t);

          for (const txid of slice) {
            const full = got.get(txid);
            if (!full) continue;

            const slim = this.normalize(full);
            loadedForEvent.push({ txid: slim.txid, transaction: slim, providerName });
          }
        } catch (e: unknown) {
          logger.debug('Mempool provider sync failed', {
            module: 'mempool-model',
            args: { providerName, error: (e as Error)?.message ?? String(e) },
          });
        } finally {
          const start = startedAt.get(providerName) ?? Date.now();
          const duration = Date.now() - start;
          const prev = this.prevDuration?.get(providerName) ?? duration;
          if (!this.prevDuration) this.prevDuration = new Map<string, number>();
          this.prevDuration.set(providerName, duration);
          this.batchSizer.tune(providerName, duration / (prev || duration));
          batchDurations[providerName] = duration;
        }
      })()
    );

    await Promise.allSettled(tasks);

    if (loadedForEvent.length > 0) {
      this.apply(
        new BitcoinMempoolSyncProcessedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          { loadedTransactions: loadedForEvent, batchDurations }
        )
      );
    }
  }

  // ====================================================================================
  // Event handlers (idempotent!)
  // ====================================================================================

  private onBitcoinMempoolInitializedEvent(_: BitcoinMempoolInitializedEvent) {
    // No-op for now. External flow starts refresh/sync.
  }

  private onBitcoinMempoolRefreshedEvent({ payload }: BitcoinMempoolRefreshedEvent) {
    const per = payload.aggregatedMetadata as ProviderSnapshot;

    this.store.applySnapshot(per || {});

    this.batchSizer.clear();
    this.prevDuration = undefined;
    this.lastUpdatedMs = Date.now();
  }

  private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
    const { loadedTransactions } = payload;
    if ((loadedTransactions || []).length > 0) {
      this.store.recordLoaded(loadedTransactions || []);
      this.lastUpdatedMs = Date.now();
    }
  }

  private onBitcoinMempoolSynchronizedEvent(_: BitcoinMempoolSynchronizedEvent) {
    // No-op: external consumer uses this to stop recursion for this fence.
  }

  // ====================================================================================
  // Read API (O(1) / O(n) helpers)
  // ====================================================================================

  public getLastUpdatedMs(): number {
    return this.lastUpdatedMs;
  }

  public *txIds(): Iterable<string> {
    yield* this.store.txIds();
  }

  public *loadedTransactions(): Iterable<LightTransaction> {
    yield* this.store.loadedTransactions();
  }

  public async *iterLoadedTransactions(): AsyncGenerator<LightTransaction> {
    for (const transaction of this.store.loadedTransactions()) {
      yield transaction;
    }
  }

  public *iterMetadata(): Iterable<MempoolTxMetadata> {
    yield* this.store.metadata();
  }

  public hasTransaction(txid: string): boolean {
    return this.store.hasTransaction(txid);
  }

  public isTransactionLoaded(txid: string): boolean {
    return this.store.isTransactionLoaded(txid);
  }

  public getTransactionMetadata(txid: string): MempoolTxMetadata | undefined {
    return this.store.getTransactionMetadata(txid);
  }

  public getFullTransaction(txid: string): LightTransaction | undefined {
    return this.store.getFullTransaction(txid);
  }

  public getStats() {
    return this.store.getStats();
  }

  public getMemoryUsage(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB') {
    return this.store.getMemoryUsage(units);
  }

  /**
   * Explicitly releases memory owned by the mempool backing store.
   *
   * This is a lifecycle cleanup hook for shutdown/tests/long-running services.
   * It does not emit domain events, does not rollback EventStore state and does
   * not unload the native addon from Node.js.
   */
  public dispose(): void {
    this.store.dispose();
  }
}
