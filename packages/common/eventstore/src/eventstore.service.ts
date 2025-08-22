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

  snapshotMinKeep?: number; // minimum snapshots to keep per aggregate
  snapshotKeepWindow?: number; // keep snapshots with blockHeight within this window from current
}

/** Tiny LRU with TTL for aggregates (latest state only). */
class LruCache<T> {
  private map = new Map<string, { v: T; exp: number; hit: number }>();
  constructor(
    private ttlMs = 60_000,
    private max = 1000
  ) {}
  get(k: string): T | null {
    const e = this.map.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) {
      this.map.delete(k);
      return null;
    }
    e.hit++;
    return e.v;
  }
  set(k: string, v: T, ttl = this.ttlMs) {
    if (this.map.size >= this.max) {
      // evict LRU: minimal hit
      let worstKey: string | null = null;
      let worstHit = Infinity;
      for (const [key, val] of this.map.entries()) {
        if (val.hit < worstHit) {
          worstHit = val.hit;
          worstKey = key;
        }
      }
      if (worstKey) this.map.delete(worstKey);
    }
    this.map.set(k, { v, exp: Date.now() + ttl, hit: 1 });
  }
  del(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

@Injectable()
export class EventStoreService<T extends AggregateRoot = AggregateRoot> implements OnModuleDestroy {
  private retryTimer: ExponentialTimer | null = null;

  // Wire budgeting (used once to compute effective budget)
  private maxOutboxBatchBytes = 512 * 1024;
  private transportMaxFrameBytes = 1024 * 1024;
  private wireEnvelopeOverheadBytes = 1024;
  private safetyMarginBytes = 2048;

  // Snapshot retention policy (to avoid deleting too aggressively)
  private snapshotMinKeep = 2;
  private snapshotKeepWindow = 0; // 0 = disabled, else keep >= currentHeight - window

  // Simple LRU for latest aggregates
  private cache = new LruCache<T>(60_000, 1000);

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

    if (cfg.snapshotMinKeep != null) this.snapshotMinKeep = cfg.snapshotMinKeep;
    if (cfg.snapshotKeepWindow != null) this.snapshotKeepWindow = cfg.snapshotKeepWindow;
  }

  /** Persist a single model or array (single-pass; outbox + aggregate tables). */
  public async save(models: T | T[]): Promise<void> {
    const aggregates = Array.isArray(models) ? models : [models];

    await this.adapter.persistAggregatesAndOutbox(aggregates);

    // Refresh cache
    for (const a of aggregates) {
      if (a.aggregateId) this.cache.set(a.aggregateId, a);
    }

    // Snapshots inline; adapter will apply retention policy hints
    await Promise.all(
      aggregates.map((a) =>
        this.adapter.createSnapshot(a, {
          minKeep: this.snapshotMinKeep,
          keepWindow: this.snapshotKeepWindow,
        })
      )
    );

    // Drain outbox by byte budget (ACK per-chunk)
    await this.drainOutboxCompletely();
  }

  /** Rollback reorg: drop everything above given height; rehydrate; optionally save new models. */
  public async rollback({
    modelsToRollback,
    blockHeight,
    modelsToSave,
  }: {
    modelsToRollback: T[];
    blockHeight: number;
    modelsToSave?: T[];
  }): Promise<void> {
    const aggIds = modelsToRollback.map((m) => m.aggregateId).filter(Boolean) as string[];

    if (aggIds.length === 0) return;

    // Clear cache for rolled back ids to avoid stale reads elsewhere
    for (const id of aggIds) this.cache.del(id);

    // Atomic rollback where possible (PG), or short IMMEDIATE phases on SQLite
    await this.adapter.rollbackAggregates(aggIds, blockHeight);

    // Rehydrate models at rollback height (from snapshot+events)
    for (const m of modelsToRollback) {
      await this.adapter.rehydrateAtHeight(m, blockHeight);
      if (m.aggregateId) this.cache.set(m.aggregateId, m);
    }

    // Optionally persist new models (e.g., system aggregates continue as usual)
    if (modelsToSave?.length) {
      await this.save(modelsToSave);
    }
  }

  // ========= OUTBOX DRAIN / STREAM =========

  /** ACK policy: we wait exactly one ACK per chunk (batch). */
  private async drainOutboxCompletely(): Promise<void> {
    const budget = this.effectiveWireBudget();
    while (true) {
      try {
        const sent = await this.adapter.fetchDeliverAckChunk(budget, async (events) => {
          await this.publisher.publishWireStreamBatchWithAck(events); // ACK per chunk
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

  // ========= READ API passthrough (with lightweight cache) =========

  public async getOne<K extends T>(model: K): Promise<K> {
    const { aggregateId } = model;
    if (!aggregateId) return model;

    const cached = this.cache.get(aggregateId) as K | null;
    if (cached) return cached;

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

    this.cache.set(aggregateId, model);
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
    await this.adapter.createSnapshot(aggregate, {
      minKeep: this.snapshotMinKeep,
      keepWindow: this.snapshotKeepWindow,
    });
  }

  public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    await this.adapter.deleteSnapshotsByBlockHeight(aggregateIds, blockHeight);
  }

  public async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number): Promise<void> {
    await this.adapter.pruneOldSnapshots(aggregateId, currentBlockHeight, {
      minKeep: this.snapshotMinKeep,
      keepWindow: this.snapshotKeepWindow,
    });
  }

  public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    await this.adapter.pruneEvents(aggregateId, pruneToBlockHeight);
  }
}
