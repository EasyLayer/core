import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ExponentialTimer, exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { Publisher } from '@easylayer/common/cqrs-transport';
import type { BaseAdapter } from './adapters/base-adapter';

export interface EventStoreConfiguration {
  maxOutboxBatchBytes?: number;
  transportMaxFrameBytes?: number;
  wireEnvelopeOverheadBytes?: number;
  safetyMarginBytes?: number;
}

@Injectable()
export class EventStoreService<T extends AggregateRoot = AggregateRoot> implements OnModuleDestroy {
  private retryTimer: ExponentialTimer | null = null;

  private maxOutboxBatchBytes = 512 * 1024;
  private transportMaxFrameBytes = 1024 * 1024;
  private wireEnvelopeOverheadBytes = 1024;
  private safetyMarginBytes = 2048;

  constructor(
    private readonly log: AppLogger,
    private readonly adapter: BaseAdapter<T>,
    private readonly publisher: Publisher
  ) {}

  onModuleDestroy() {
    this.retryTimer?.destroy();
    this.retryTimer = null;
  }

  public configure(cfg: EventStoreConfiguration): void {
    if (cfg.maxOutboxBatchBytes != null) this.maxOutboxBatchBytes = cfg.maxOutboxBatchBytes;
    if (cfg.transportMaxFrameBytes != null) this.transportMaxFrameBytes = cfg.transportMaxFrameBytes;
    if (cfg.wireEnvelopeOverheadBytes != null) this.wireEnvelopeOverheadBytes = cfg.wireEnvelopeOverheadBytes;
    if (cfg.safetyMarginBytes != null) this.safetyMarginBytes = cfg.safetyMarginBytes;
  }

  // ========= SAVE =========

  public async save(models: T | T[]): Promise<void> {
    const aggregates = Array.isArray(models) ? models : [models];
    await this.adapter.persistAggregatesAndOutbox(aggregates);
    await Promise.all(aggregates.map((a) => this.adapter.createSnapshot(a)));
    await this.drainOutboxCompletely();
  }

  // ========= OUTBOX DRAIN / STREAM =========

  private async drainOutboxCompletely(): Promise<void> {
    const budget = this.effectiveWireBudget();
    while (true) {
      try {
        const sent = await this.adapter.fetchDeliverAckChunk(budget, async (events) => {
          // send one batch and wait ACK
          await this.publisher.publishWireStreamBatchWithAck(events);
        });
        if (sent === 0) break;
      } catch (e) {
        this.log.debug('Outbox drain error — scheduling retry', { args: { error: (e as any)?.message } });
        this.startRetryTimerIfNeeded();
        throw e;
      }
    }
  }

  private effectiveWireBudget(): number {
    const limit = Math.max(4 * 1024, this.maxOutboxBatchBytes);
    const ceiling = Math.max(
      8 * 1024,
      this.transportMaxFrameBytes - this.wireEnvelopeOverheadBytes - this.safetyMarginBytes
    );
    return Math.min(limit, ceiling);
  }

  private startRetryTimerIfNeeded(): void {
    if (this.retryTimer) return;
    this.retryTimer = exponentialIntervalAsync(
      async (reset) => {
        try {
          await this.drainOutboxCompletely();
          reset();
          this.retryTimer?.destroy();
          this.retryTimer = null;
        } catch {
          /* keep retrying */
        }
      },
      { interval: 1000, multiplier: 2, maxInterval: 8000 }
    );
  }

  // ========= READ API passthrough =========

  public async getOne<K extends T>(model: K): Promise<K> {
    const { aggregateId } = model;
    if (!aggregateId) return model;

    const snap = await this.adapter.findLatestSnapshot(aggregateId);
    if (snap) {
      const snapshotData = await this.adapter.createSnapshotAtHeight(model, snap.blockHeight);
      model.fromSnapshot({
        aggregateId: snapshotData.aggregateId,
        version: snapshotData.version,
        blockHeight: snapshotData.blockHeight,
        payload: typeof snapshotData.payload === 'string' ? JSON.parse(snapshotData.payload) : snapshotData.payload,
      });
      await this.adapter.applyEventsToAggregate(model, model.version);
    } else {
      await this.adapter.applyEventsToAggregate(model);
    }
    return model;
  }

  public async getAtBlockHeight<K extends T>(model: K, blockHeight: number): Promise<K> {
    const snapshotData = await this.adapter.createSnapshotAtHeight(model, blockHeight);
    model.fromSnapshot({
      aggregateId: snapshotData.aggregateId,
      version: snapshotData.version,
      blockHeight: snapshotData.blockHeight,
      payload: typeof snapshotData.payload === 'string' ? JSON.parse(snapshotData.payload) : snapshotData.payload,
    });
    return model;
  }

  public async fetchEventsForAggregates(
    aggregateIds: string[],
    options?: { version?: number; blockHeight?: number; limit?: number; offset?: number }
  ): Promise<DomainEvent[]> {
    return this.adapter.fetchEventsForAggregates(aggregateIds, options);
  }

  public async createSnapshot(aggregate: T): Promise<void> {
    await this.adapter.createSnapshot(aggregate);
  }

  public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    await this.adapter.deleteSnapshotsByBlockHeight(aggregateIds, blockHeight);
  }

  public async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number): Promise<void> {
    await this.adapter.pruneOldSnapshots(aggregateId, currentBlockHeight);
  }

  public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    await this.adapter.pruneEvents(aggregateId, pruneToBlockHeight);
  }
}
