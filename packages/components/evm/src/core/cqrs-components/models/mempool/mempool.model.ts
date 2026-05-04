import type { Logger } from '@nestjs/common';
import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService } from '../../../blockchain-provider/blockchain-provider.service';
import type { MempoolTxMetadata } from '../../../blockchain-provider/providers/interfaces';
import type { EvmMempoolStateStore } from '../../../native';
import { createEvmMempoolStateStore } from './mempool-state.store';
import { BatchSizer } from './components';
import {
  EvmMempoolInitializedEvent,
  EvmMempoolRefreshedEvent,
  EvmMempoolTransactionReplacedEvent,
  EvmMempoolSyncProcessedEvent,
  EvmMempoolSynchronizedEvent,
  EvmMempoolTxsConfirmedEvent,
} from '../../events/mempool';

export type MempoolSnapshot = Record<string, Array<{ hash: string; metadata: MempoolTxMetadata }>>;

/**
 * EVM mempool aggregate.
 *
 * Domain/CQRS behavior stays in TypeScript. The heavy mutable structures are
 * delegated to `EvmMempoolStateStore`, which is Rust-backed in Node when the
 * native addon is available and falls back to a JS implementation in browser/tests.
 *
 * EVM-specific behavior:
 * - replacement detection is `(from, nonce)` based;
 * - refresh mode can be `snapshot` (`txpool_content`) or `additive` (`newPendingTransactions` WS);
 * - loaded tx payloads do not store calldata/input in the state store;
 * - all gas/wei fields are decimal strings in public normalized models.
 */
export class Mempool extends AggregateRoot {
  private minGasPrice: bigint;
  private maxPendingCount: number;
  private pendingTxTtlMs: number;

  private batchSizer = new BatchSizer(100, 10, 1000);
  private prevDuration: Map<string, number> | undefined;
  private store: EvmMempoolStateStore = createEvmMempoolStateStore();
  private lastUpdatedMs = Date.now();

  constructor({
    aggregateId,
    blockHeight,
    minGasPrice = 1_000_000_000n,
    maxPendingCount = 10_000,
    pendingTxTtlMs = 30 * 60 * 1000,
    options,
  }: {
    aggregateId: string;
    blockHeight: number;
    minGasPrice?: bigint;
    maxPendingCount?: number;
    pendingTxTtlMs?: number;
    options?: any;
  }) {
    super(aggregateId, blockHeight, options);
    this.minGasPrice = minGasPrice;
    this.maxPendingCount = maxPendingCount;
    this.pendingTxTtlMs = pendingTxTtlMs;
  }

  private effectiveGasPrice(meta: MempoolTxMetadata): bigint {
    const parse = (value?: string): bigint => {
      if (!value) return 0n;
      try {
        return BigInt(value);
      } catch {
        return 0n;
      }
    };
    return parse(meta.maxFeePerGas) || parse(meta.gasPrice);
  }

  private meetsMinGasPrice(meta: MempoolTxMetadata): boolean {
    return this.effectiveGasPrice(meta) >= this.minGasPrice;
  }

  protected serializeUserState(): Record<string, any> {
    return {
      minGasPrice: this.minGasPrice.toString(),
      maxPendingCount: this.maxPendingCount,
      pendingTxTtlMs: this.pendingTxTtlMs,
      mempoolStore: this.store.exportSnapshot(),
    };
  }

  protected restoreUserState(state: any): void {
    this.minGasPrice = state?.minGasPrice ? BigInt(state.minGasPrice) : 1_000_000_000n;
    this.maxPendingCount = state?.maxPendingCount ?? 10_000;
    this.pendingTxTtlMs = state?.pendingTxTtlMs ?? 30 * 60 * 1000;
    this.batchSizer = new BatchSizer(100, 10, 1000);
    this.prevDuration = undefined;
    this.store = createEvmMempoolStateStore();
    this.store.importSnapshot(state?.mempoolStore ?? state);
    Object.setPrototypeOf(this, Mempool.prototype);
  }

  public async init({
    requestId,
    height,
    logger,
  }: {
    requestId: string;
    height: number;
    logger?: Logger;
  }): Promise<void> {
    this.apply(new EvmMempoolInitializedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: height }, {}));

    logger?.log('Mempool successfully initialized', {
      module: 'mempool-model',
      args: {
        lastHeight: height,
      },
    });
  }

  public async refresh({
    requestId,
    height,
    perProvider,
    mode,
    logger,
  }: {
    requestId: string;
    height: number;
    perProvider: MempoolSnapshot;
    mode: 'snapshot' | 'additive';
    logger?: Logger;
  }): Promise<void> {
    const seen = new Set<string>();
    const filtered: MempoolSnapshot = {};
    const replacements: Array<{ oldHash: string; newHash: string; from: string; nonce: number; provider: string }> = [];

    for (const [provider, items] of Object.entries(perProvider)) {
      if (!Array.isArray(items) || items.length === 0) continue;

      const out: Array<{ hash: string; metadata: MempoolTxMetadata }> = [];
      for (const { hash, metadata } of items) {
        if (!hash || seen.has(hash)) continue;
        if (!this.meetsMinGasPrice(metadata)) continue;
        seen.add(hash);

        if (mode === 'additive' && metadata.from && metadata.nonce !== undefined) {
          const existing = this.store.getReplacementCandidate(metadata.from, metadata.nonce);
          if (existing && existing.hash !== hash) {
            const existingGas = this.effectiveGasPrice(existing.metadata);
            const newGas = this.effectiveGasPrice(metadata);
            if (newGas >= (existingGas * 110n) / 100n) {
              replacements.push({
                oldHash: existing.hash,
                newHash: hash,
                from: metadata.from,
                nonce: metadata.nonce,
                provider,
              });
            } else {
              continue;
            }
          }
        }

        out.push({ hash, metadata });
      }
      if (out.length > 0) filtered[provider] = out;
    }

    for (const replacement of replacements) {
      this.apply(
        new EvmMempoolTransactionReplacedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: height },
          {
            oldHash: replacement.oldHash,
            newHash: replacement.newHash,
            from: replacement.from,
            nonce: replacement.nonce,
            providerName: replacement.provider,
          }
        )
      );
    }

    this.apply(
      new EvmMempoolRefreshedEvent(
        { aggregateId: this.aggregateId, requestId, blockHeight: height },
        { aggregatedMetadata: filtered, mode }
      )
    );

    logger?.log('Mempool refreshed', {
      module: 'mempool-model',
      args: { mode, providers: Object.keys(filtered).length },
    });
  }

  public async sync({
    requestId,
    service,
    logger,
  }: {
    requestId: string;
    service: BlockchainProviderService;
    logger?: Logger;
  }): Promise<void> {
    const byProvider = new Map<string, string[]>();
    for (const provider of this.store.providers()) {
      const pending = this.store.pendingHashes(provider, this.batchSizer.get(provider));
      if (pending.length > 0) byProvider.set(provider, pending);
    }

    if (byProvider.size === 0) {
      this.apply(
        new EvmMempoolSynchronizedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          {}
        )
      );
      logger?.log('Mempool synced', {
        module: 'mempool-model',
        args: { mempool: this.store.getStats() },
      });
      return;
    }

    const loaded: Array<{ hash: string; metadata: MempoolTxMetadata; providerName?: string }> = [];
    const batchDurations: Record<string, number> = {};

    const tasks = Array.from(byProvider.entries()).map(([providerName, hashes]) =>
      (async () => {
        const t0 = Date.now();
        try {
          for (const hash of hashes) {
            const metadata = await service.getPendingTransactionByHash(hash);
            if (metadata) loaded.push({ hash, metadata, providerName });
          }
        } catch (error) {
          logger?.debug('Mempool sync batch failed', { args: { providerName, error: (error as Error)?.message } });
        } finally {
          const duration = Date.now() - t0;
          const previous = this.prevDuration?.get(providerName) ?? duration;
          if (!this.prevDuration) this.prevDuration = new Map();
          this.prevDuration.set(providerName, duration);
          this.batchSizer.tune(providerName, duration / (previous || duration));
          batchDurations[providerName] = duration;
        }
      })()
    );

    await Promise.allSettled(tasks);

    if (loaded.length > 0) {
      this.apply(
        new EvmMempoolSyncProcessedEvent(
          { aggregateId: this.aggregateId, requestId, blockHeight: this.lastBlockHeight },
          { loadedTransactions: loaded, batchDurations }
        )
      );
    }
  }

  public async removeConfirmed({
    requestId,
    hashes,
    height,
  }: {
    requestId: string;
    hashes: string[];
    height: number;
  }): Promise<void> {
    const toRemove = hashes.filter((hash) => this.store.hasTransaction(hash));
    if (toRemove.length === 0) return;
    this.apply(
      new EvmMempoolTxsConfirmedEvent(
        { aggregateId: this.aggregateId, requestId, blockHeight: height },
        { confirmedHashes: toRemove }
      )
    );
  }

  private onEvmMempoolInitializedEvent(_: EvmMempoolInitializedEvent): void {}

  private onEvmMempoolTransactionReplacedEvent({ payload }: EvmMempoolTransactionReplacedEvent): void {
    this.store.removeHash(payload.oldHash);
  }

  private onEvmMempoolRefreshedEvent({ payload }: EvmMempoolRefreshedEvent): void {
    const incoming = payload.aggregatedMetadata as MempoolSnapshot;
    if (payload.mode === 'snapshot') {
      this.store.applySnapshot(incoming);
      this.batchSizer.clear();
      this.prevDuration = undefined;
    } else {
      this.store.addTransactions(incoming, this.maxPendingCount);
    }

    this.store.pruneTtl(this.pendingTxTtlMs);
    this.lastUpdatedMs = Date.now();
  }

  private onEvmMempoolSyncProcessedEvent({ payload }: EvmMempoolSyncProcessedEvent): void {
    this.store.recordLoaded(payload.loadedTransactions || []);
  }

  private onEvmMempoolSynchronizedEvent(_: EvmMempoolSynchronizedEvent): void {}

  private onEvmMempoolTxsConfirmedEvent({ payload }: EvmMempoolTxsConfirmedEvent): void {
    this.store.removeHashes(payload.confirmedHashes);
  }

  public hasTransaction(hash: string): boolean {
    return this.store.hasTransaction(hash);
  }

  public getTransactionMetadata(hash: string): MempoolTxMetadata | undefined {
    return this.store.getTransactionMetadata(hash);
  }

  public isTransactionLoaded(hash: string): boolean {
    return this.store.isTransactionLoaded(hash);
  }

  public getStats(): { total: number; loaded: number; providers: number; nonceIndex: number } {
    return this.store.getStats();
  }

  public getLastUpdatedMs(): number {
    return this.lastUpdatedMs;
  }

  public dispose(): void {
    this.store.dispose();
  }
}
