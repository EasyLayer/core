import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { BlockchainProviderService } from '../blockchain-provider/blockchain-provider.service';
import type { MempoolCommandExecutor } from './interfaces';
import type { MempoolTxMetadata } from '../blockchain-provider/providers/interfaces';
import type { MempoolSnapshot } from '../cqrs-components/models/mempool/mempool.model';

/**
 * EVM MempoolLoaderService — two strategies:
 *
 * 'subscribe-ws': Subscribe to newPendingTransactions WS events.
 *   - Accumulate tx hashes in buffer
 *   - Periodically flush: batch-fetch metadata → dispatch RefreshMempoolCommand (mode=additive)
 *   - Eviction happens in AddBlocksBatchCommandHandler (cross-ref confirmed hashes)
 *
 * 'txpool-content': Poll txpool_content (Geth/Erigon).
 *   - Like bitcoin getrawmempool
 *   - Dispatch RefreshMempoolCommand (mode=snapshot)
 *   - Eviction automatic (not in next snapshot)
 *
 * Lifecycle mirrors bitcoin MempoolLoaderService:
 *   start() → enable + setup
 *   unlock() → allow next cycle
 *   refresh(height) → trigger new cycle
 */
@Injectable()
export class MempoolLoaderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MempoolLoaderService.name);
  private readonly moduleName = 'blocks-queue';

  private enabled = false;
  private locked = false;
  private lastKnownHeight = 0;

  // subscribe-ws mode
  private pendingBuffer: Set<string> = new Set();
  private subscription?: { unsubscribe(): void };
  private flushTimer?: ReturnType<typeof setInterval>;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly provider: BlockchainProviderService,
    @Inject('MempoolCommandExecutor')
    private readonly executor: MempoolCommandExecutor,
    private readonly strategyName: 'subscribe-ws' | 'txpool-content',
    flushIntervalMs = 5_000
  ) {
    this.flushIntervalMs = flushIntervalMs;
  }

  onModuleInit() {
    this.log.verbose('Mempool loader service initialized', {
      module: this.moduleName,
      args: { strategy: this.strategyName },
    });
  }

  async onModuleDestroy() {
    this.stop();
  }

  /** Called after EvmMempoolInitializedEvent. Idempotent. */
  public async start(): Promise<void> {
    if (this.enabled) return;
    if (!this.provider.isMempoolAvailable) {
      throw new Error(
        `Mempool loader strategy ${this.strategyName} is enabled but no compatible mempool provider is available`
      );
    }

    await this.provider.assertRuntimeCompatibility({ mempoolStrategy: this.strategyName });
    this.enabled = true;

    if (this.strategyName === 'subscribe-ws') {
      this.setupWsSubscription();
      this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    }

    this.log.verbose('Mempool loader started', { module: this.moduleName, args: { strategy: this.strategyName } });
  }

  public stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.enabled = false;
    this.locked = false;
    this.pendingBuffer.clear();
  }

  /** External signal that current cycle finished — allow next cycle. */
  public unlock(): void {
    if (this.locked) {
      this.locked = false;
      this.log.verbose('Mempool unlock', { module: this.moduleName });
    }
  }

  /**
   * Called after confirmProcessedBatch / reorganizeBlocks.
   * Updates lastKnownHeight and triggers next cycle.
   */
  public async refresh(height: number): Promise<void> {
    if (!this.enabled) return;
    this.lastKnownHeight = height;
    this.unlock();

    if (this.strategyName === 'subscribe-ws') {
      await this.flush();
    } else {
      await this.pollTxpoolContent();
    }
  }

  // ===== SUBSCRIBE-WS STRATEGY =====

  private setupWsSubscription(): void {
    try {
      this.subscription = this.provider.subscribeToPendingTransactions((txHash: string) =>
        this.pendingBuffer.add(txHash)
      );
    } catch (e: any) {
      this.log.warn('Failed to subscribe to pending transactions', {
        module: this.moduleName,
        args: { error: e.message },
      });
    }
  }

  private async flush(): Promise<void> {
    if (!this.enabled || this.locked || this.pendingBuffer.size === 0) return;

    const hashes = Array.from(this.pendingBuffer);
    this.pendingBuffer.clear();

    this.log.verbose('Mempool flush', { module: this.moduleName, args: { count: hashes.length } });

    // Batch fetch metadata
    const metas: Array<{ hash: string; metadata: MempoolTxMetadata }> = [];
    // Fetch in parallel with a reasonable concurrency limit
    const CONCURRENCY = 20;
    for (let i = 0; i < hashes.length; i += CONCURRENCY) {
      const batch = hashes.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((hash) => this.provider.getPendingTransactionByHash(hash)));
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result && result.status === 'fulfilled' && result.value) {
          metas.push({ hash: batch[j]!, metadata: result.value });
        }
      }
    }

    if (metas.length === 0) return;

    const perProvider: MempoolSnapshot = { 'ws-stream': metas };

    try {
      await this.executor.handleSnapshot({
        requestId: uuidv4(),
        height: this.lastKnownHeight,
        perProvider,
        mode: 'additive',
      });
      this.locked = true;
      this.log.verbose('Mempool additive snapshot dispatched', {
        module: this.moduleName,
        args: { count: metas.length },
      });
    } catch (e: any) {
      this.log.warn('Failed to dispatch mempool snapshot', { module: this.moduleName, args: { error: e.message } });
    }
  }

  // ===== TXPOOL-CONTENT STRATEGY =====

  private async pollTxpoolContent(): Promise<void> {
    if (!this.enabled || this.locked) return;

    try {
      const raw = await this.provider.getRawMempoolFromAll();
      if (!raw.length) return;

      const perProvider: MempoolSnapshot = {};
      for (const { providerName, value } of raw) {
        const items = Object.entries(value).map(([hash, meta]) => ({ hash, metadata: meta }));
        if (items.length > 0) perProvider[providerName] = items;
      }

      if (Object.keys(perProvider).length === 0) return;

      await this.executor.handleSnapshot({
        requestId: uuidv4(),
        height: this.lastKnownHeight,
        perProvider,
        mode: 'snapshot',
      });
      this.locked = true;

      this.log.verbose('Mempool snapshot dispatched (txpool-content)', {
        module: this.moduleName,
        args: { providers: Object.keys(perProvider).length },
      });
    } catch (e: any) {
      this.log.warn('txpool_content poll failed', { module: this.moduleName, args: { error: e.message } });
    }
  }
}
