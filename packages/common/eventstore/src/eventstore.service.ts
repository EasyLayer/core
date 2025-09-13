import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ExponentialTimer, exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { Publisher, WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { BaseAdapter } from './adapters/base-adapter';

/**
 * Public service configuration.
 * NOTE: chunk sizing is adapter-owned; the service passes only the transport ceiling.
 */
export interface EventStoreConfiguration {
  /** Hard cap per transport frame (e.g., gRPC/HTTP limit). */
  transportMaxFrameBytes?: number;
}

/** Minimal TTL-based LRU for hot aggregates (read-path acceleration). */
class LruCache<T> {
  private map = new Map<string, { v: T; exp: number; hit: number }>();
  constructor(
    private ttlMs = 60_000,
    private max = 1000
  ) {}

  get(k: string): T | null {
    const e = this.map.get(k);
    if (!e) {
      return null;
    }
    if (Date.now() > e.exp) {
      this.map.delete(k);
      return null;
    }
    e.hit++;
    return e.v;
  }

  set(k: string, v: T, ttl = this.ttlMs): void {
    if (this.map.size >= this.max) {
      let worstKey: string | null = null;
      let worstHit = Infinity;
      for (const [key, val] of this.map.entries()) {
        if (val.hit < worstHit) {
          worstHit = val.hit;
          worstKey = key;
        }
      }
      if (worstKey) {
        this.map.delete(worstKey);
      }
    }
    this.map.set(k, { v, exp: Date.now() + ttl, hit: 1 });
  }

  del(k: string): void {
    this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}

@Injectable()
export class EventStoreService<T extends AggregateRoot = AggregateRoot> implements OnModuleInit, OnModuleDestroy {
  private retryTimer: ExponentialTimer | null = null;

  // The only wire-related knob on the service level.
  private transportMaxFrameBytes = 1024 * 1024;

  // Read-path cache for hot aggregates.
  private cache = new LruCache<T>(60_000, 1000);

  private draining: Promise<void> | null = null;

  constructor(
    private readonly log: AppLogger,
    private readonly adapter: BaseAdapter<T>,
    private readonly publisher: Publisher,
    config: any
  ) {
    if (config?.transportMaxFrameBytes !== undefined) this.transportMaxFrameBytes = config.transportMaxFrameBytes;
  }

  async onModuleInit(): Promise<void> {
    await this.runDrainOnce();
  }

  onModuleDestroy(): void {
    this.retryTimer?.destroy();
    this.retryTimer = null;
  }

  private async runDrainOnce(): Promise<void> {
    if (this.draining) {
      await this.draining;
      return;
    }

    this.draining = (async () => {
      try {
        await this.drainOutboxCompletely();
      } finally {
        this.draining = null;
      }
    })();

    await this.draining;
  }

  /**
   * Persist → snapshot → publish (RAW fast-path if safe; otherwise strict outbox) → ACK.
   * DB writes and outbox are atomic per adapter implementation.
   */
  public async save(models: T | T[]): Promise<void> {
    const aggregates = Array.isArray(models) ? models : [models];

    // One DB transaction that writes aggregate tables + outbox.
    const persisted = await this.adapter.persistAggregatesAndOutbox(aggregates);

    // Refresh read cache.
    for (const a of aggregates) {
      if (a.aggregateId) {
        this.cache.set(a.aggregateId, a);

        await this.maybeCreateSnapshot(a);
      }
    }

    // Publish using the correct flow based on backlog conditions.
    await this.publishWithCorrectFlow(persisted);
  }

  /**
   * 1) If backlog exists before our first inserted row → strict drain (respect order).
   * 2) If anything appeared after current watermark (concurrency) → strict drain.
   * 3) Otherwise → RAW fast-path publish from memory, then ACK delete just inserted ids.
   */
  private async publishWithCorrectFlow(persisted: {
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }): Promise<void> {
    const backlogBefore = await this.adapter.hasBacklogBefore(persisted.firstTs, persisted.firstId);
    if (backlogBefore) {
      await this.runDrainOnce();
      return;
    }

    const anyPending = await this.adapter.hasAnyPendingAfterWatermark();
    if (anyPending) {
      await this.runDrainOnce();
      return;
    }

    if (persisted.rawEvents.length > 0) {
      await this.publisher.publishWireStreamBatchWithAck(persisted.rawEvents);
      await this.adapter.deleteOutboxByIds(persisted.insertedOutboxIds);
    }
  }

  // ───────────────────────────── ROLLBACK / REHYDRATE ─────────────────────────────

  public async rollback({
    modelsToRollback,
    blockHeight,
    modelsToSave,
  }: {
    modelsToRollback: T[];
    blockHeight: number;
    modelsToSave?: T[];
  }): Promise<void> {
    const ids = modelsToRollback.map((m) => m.aggregateId).filter(Boolean) as string[];
    if (ids.length === 0) {
      return;
    }

    for (const id of ids) {
      this.cache.del(id);
    }

    await this.adapter.rollbackAggregates(ids, blockHeight);

    for (const m of modelsToRollback) {
      if (modelsToSave && modelsToSave.some((s) => s.aggregateId === m.aggregateId)) {
        continue;
      }
      await this.adapter.rehydrateAtHeight(m, blockHeight);
      if (m.aggregateId) {
        this.cache.set(m.aggregateId, m);
      }
    }

    if (modelsToSave?.length) {
      await this.save(modelsToSave);
    }
  }

  // ───────────────────────────── OUTBOX DRAIN ─────────────────────────────

  /**
   * Drains the outbox in multiple chunks. ACK policy: one ACK per chunk.
   * Chunk sizing and EMA hints are adapter-owned; service gives only the transport cap.
   */
  private async drainOutboxCompletely(): Promise<void> {
    while (true) {
      try {
        const sent = await this.adapter.fetchDeliverAckChunk(this.transportMaxFrameBytes, async (events) => {
          await this.publisher.publishWireStreamBatchWithAck(events);
        });
        if (sent === 0) {
          break;
        }
      } catch (e) {
        this.log.debug('Outbox drain error — scheduling retry', { args: { error: (e as any)?.message } });
        this.startRetryTimerIfNeeded();
        throw e;
      }
    }
  }

  private startRetryTimerIfNeeded(): void {
    if (this.retryTimer) {
      return;
    }
    this.retryTimer = exponentialIntervalAsync(
      async (reset) => {
        try {
          await this.runDrainOnce();
          reset();
          this.retryTimer?.destroy();
          this.retryTimer = null;
        } catch {
          // keep retrying
        }
      },
      { interval: 1000, multiplier: 2, maxInterval: 8000 }
    );
  }

  // ───────────────────────────── READ API (cached) ─────────────────────────────

  public async getOne<K extends T>(model: K): Promise<K> {
    const id = model.aggregateId;
    if (!id) {
      return model;
    }

    const cached = this.cache.get(id) as K | null;
    if (cached) {
      return cached;
    }

    const snap = await this.adapter.findLatestSnapshot(id);
    if (snap) {
      const at = await this.adapter.createSnapshotAtHeight(model, snap.blockHeight);
      model.fromSnapshot({
        aggregateId: at.aggregateId,
        version: at.version,
        blockHeight: at.blockHeight,
        // Snapshot deserialization returns a parsed object already.
        payload: at.payload,
      });
      await this.adapter.applyEventsToAggregate(model, model.version);
    } else {
      await this.adapter.applyEventsToAggregate(model);
    }

    this.cache.set(id, model);
    return model;
  }

  public async getAtBlockHeight<K extends T>(model: K, blockHeight: number): Promise<K> {
    const snap = await this.adapter.createSnapshotAtHeight(model, blockHeight);
    model.fromSnapshot({
      aggregateId: snap.aggregateId,
      version: snap.version,
      blockHeight: snap.blockHeight,
      payload: snap.payload,
    });
    return model;
  }

  public async fetchEventsForAggregates(
    aggregateIds: string[],
    options?: { version?: number; blockHeight?: number; limit?: number; offset?: number }
  ): Promise<DomainEvent[]> {
    return this.adapter.fetchEventsForAggregates(aggregateIds, options);
  }

  /** Create a snapshot for a single aggregate if it says it’s time. */
  public async maybeCreateSnapshot(aggregate: T): Promise<void> {
    if (!aggregate.canMakeSnapshot()) {
      return;
    }

    const { minKeep, keepWindow } = aggregate.getSnapshotRetention();
    try {
      await this.adapter.createSnapshot(aggregate, { minKeep, keepWindow });
      // Snapshot successfully created → reset the counter on the aggregate
      aggregate.resetSnapshotCounter();
    } catch (err: any) {
      // We swallow snapshot errors by policy: log & continue
      this.log.warn('Snapshot create failed (ignored)', {
        args: { aggregateId: aggregate.aggregateId, error: err?.message },
      });
    }
  }

  // public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
  //   await this.adapter.deleteSnapshotsByBlockHeight(aggregateIds, blockHeight);
  // }

  // public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
  //   await this.adapter.pruneEvents(aggregateId, pruneToBlockHeight);
  // }
}
