import { Injectable, Logger } from '@nestjs/common';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import type { SnapshotReadRow } from './snapshots.model';
import type { EventReadRow } from './event-data.model';
import type { FindEventsOptions, BaseAdapter } from './base-adapter';

/** Minimal TTL-based LRU for hot aggregates (read-path acceleration). (kept) */
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
      if (worstKey) this.map.delete(worstKey);
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

/**
 * Read-only facade over adapter's read operations.
 * Does not perform writes, snapshots creation, or publishing.
 */
@Injectable()
export class EventStoreReadService<T extends AggregateRoot = AggregateRoot> {
  logger = new Logger(EventStoreReadService.name);

  // Read-path cache for hot aggregates.
  private _cache = new LruCache<T>(60_000, 1000);

  constructor(private readonly adapter: BaseAdapter<T>) {}

  get cache(): LruCache<T> {
    return this._cache;
  }

  public async getOne<K extends T>(model: K): Promise<K> {
    const id = model.aggregateId;
    if (!id) return model;

    const cached = this._cache.get(id) as K | null;
    if (cached) return cached;

    // Single adapter call: rehydrate to the latest persisted height (snapshot + tail events).
    await this.adapter.rehydrateLatest(model);

    this._cache.set(id, model);
    return model;
  }

  // ─────────────────────────────── EVENTS ───────────────────────────────

  public async fetchEventsForManyAggregates(
    aggregateIds: string[],
    options: FindEventsOptions = {}
  ): Promise<EventReadRow[]> {
    return this.adapter.fetchEventsForManyAggregatesRead(aggregateIds, options);
  }

  public async fetchEventsForOneAggregate(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): Promise<EventReadRow[]> {
    return this.adapter.fetchEventsForOneAggregateRead(aggregateId, options);
  }

  public async *streamEventsForOneAggregate(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    yield* this.adapter.streamEventsForOneAggregateRead(aggregateId, options);
  }

  public async *streamEventsForManyAggregates(
    aggregateIds: string[],
    options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    yield* this.adapter.streamEventsForManyAggregatesRead(aggregateIds, options);
  }

  // ─────────────────────────────── MODELS ───────────────────────────────

  /** Return model state at height as SnapshotReadRow (payload string). */
  public async getOneModelByHeight(model: T, blockHeight: number): Promise<SnapshotReadRow | null> {
    return this.adapter.getOneModelByHeightRead(model, blockHeight);
  }

  public async getManyModelsByHeight(models: T[], blockHeight: number): Promise<SnapshotReadRow[]> {
    return this.adapter.getManyModelsByHeightRead(models, blockHeight);
  }
}
