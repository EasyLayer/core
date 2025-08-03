import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { Repository, MoreThan, LessThanOrEqual, DataSource } from 'typeorm';
import type { ObjectLiteral } from 'typeorm';
import { AggregateRoot, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { EventDataParameters, deserialize } from './event-data.model';
import { toSnapshot, SnapshotInterface, SnapshotParameters, fromSnapshot } from './snapshots.model';
import { CompressionMetrics } from './compression.utils';

type DriverType = 'sqlite' | 'postgres';

type FindEventsOptions = {
  version?: number;
  blockHeight?: number;
  status?: string;
  limit?: number;
  offset?: number;
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTTL: number;
  private maxSize: number;

  constructor(defaultTTL: number = 60000, maxSize: number = 1000) {
    this.defaultTTL = defaultTTL;
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Update access statistics for LRU
    cached.accessCount++;
    cached.lastAccessed = Date.now();

    return cached.value;
  }

  set(key: string, value: T, ttl?: number): void {
    const expiresAt = Date.now() + (ttl || this.defaultTTL);

    // If cache is at max size, remove least recently used item
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      value,
      expiresAt,
      accessCount: 1,
      lastAccessed: Date.now(),
    });
  }

  clear(key: string): void {
    this.cache.delete(key);
  }

  private evictLRU(): void {
    let lruKey = '';
    let lruTime = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < lruTime) {
        lruTime = entry.lastAccessed;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
    }
  }

  // Get cache statistics for monitoring
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }
}

@Injectable()
export class EventStoreReadRepository<T extends AggregateRoot = AggregateRoot> {
  private _cache = new LRUCache<T>(60000, 1000); // TTL 60 seconds, max 1000 items
  private isSqlite: boolean;
  private dbDriver: DriverType;

  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource
  ) {
    this.isSqlite = this.dataSource.options.type === 'sqlite';
    this.dbDriver = this.isSqlite ? 'sqlite' : 'postgres';
  }

  get cache() {
    return this._cache;
  }

  public async getOne<K extends T>(model: K): Promise<K> {
    // IMPORTANT: We have to go over the model of the unit here even if it is empty
    const { aggregateId } = model;

    if (!aggregateId) {
      return model;
    }

    const cachedModel = this._cache.get(aggregateId) as K;

    if (cachedModel) {
      this.log.debug('Cache hit for aggregate', { args: { aggregateId } });
      return cachedModel;
    }

    this.log.debug('Cache miss, loading from database', { args: { aggregateId } });

    const snapshotRepo = this.getRepository('snapshots');
    const snapshot = await snapshotRepo.findOneBy({ aggregateId });

    if (!snapshot) {
      if (this.isSqlite) {
        await this.applyEventsInBatches({ model });
      } else {
        await this.applyEventsStreamToAggregate({ model });
      }

      // Cache the loaded model
      this._cache.set(aggregateId, model);
      return model;
    }

    // If the snapshot was in the database,
    // then we still need to check
    // its relevance by getting events according to a version higher than that of the snapshot.

    // fromSnapshot() handles decompression internally and returns object
    const decompressedSnapshot = await fromSnapshot(snapshot, this.dbDriver);

    // Aggregate receives object directly in loadFromSnapshot
    model.loadFromSnapshot(decompressedSnapshot);

    if (this.isSqlite) {
      await this.applyEventsInBatches({ model, lastVersion: model.version });
    } else {
      await this.applyEventsStreamToAggregate({ model, lastVersion: model.version });
    }

    // Cache the loaded model
    this._cache.set(aggregateId, model);
    return model;
  }

  public async applyEventsInBatches(options: any) {
    return this._applyEventsInBatches(options);
  }

  public async applyEventsStreamToAggregate(options: any) {
    return this._applyEventsStreamToAggregate(options);
  }

  private getRepository<T extends ObjectLiteral = any>(aggregateId: string): Repository<T> {
    const entityMetadata = this.dataSource.entityMetadatasMap.get(aggregateId);

    if (!entityMetadata) {
      throw new Error(`Entity with name "${aggregateId}" not found.`);
    }

    return this.dataSource.getRepository<T>(entityMetadata.target);
  }

  public async fetchEventsForManyAggregates(
    aggregateIds: string[],
    options: FindEventsOptions = {}
  ): Promise<BasicEvent<EventBasePayload>[]> {
    const perAggregateArrays = await Promise.all(
      aggregateIds.map((id) => this.fetchEventsForOneAggregate(id, options))
    );

    // TODO: think if we really need this
    // We glue them together into one array
    return perAggregateArrays.flat();
  }

  public async fetchEventsForOneAggregate(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): Promise<BasicEvent<EventBasePayload>[]> {
    const { version, blockHeight, status, limit, offset } = options;

    const repo = this.getRepository(aggregateId);
    const qb = repo
      .createQueryBuilder('e')
      .where('e.version > :version', { version: version ?? 0 })
      .addOrderBy('e.version', 'ASC');

    if (blockHeight != null) {
      qb.andWhere('e.blockHeight <= :bh', { bh: blockHeight });
    }

    if (status != null) {
      qb.andWhere('e.status = :status', { status });
    }

    // Pagination
    if (offset != null) {
      qb.skip(offset);
    }
    if (limit != null) {
      qb.take(limit);
    }

    const rawEvents = await qb.getMany();
    this.log.debug('Raw events fetched', { args: { aggregateId, count: rawEvents.length } });

    // deserialize() now handles decompression internally
    const processedEvents = await Promise.all(
      rawEvents.map(async (raw) => {
        const historyEvent = await deserialize(aggregateId, raw, this.dbDriver);
        return historyEvent.event;
      })
    );

    this.log.debug('Deserialized events', { args: { deserializedCount: processedEvents.length } });

    return processedEvents;
  }

  public async *streamEventsForOneAggregate(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): AsyncGenerator<BasicEvent<EventBasePayload>, void, unknown> {
    const { version, blockHeight, status, limit, offset } = options;
    const repo = this.getRepository(aggregateId);

    if (this.isSqlite) {
      // For SQLite - use batch streaming with pagination
      yield* this.streamEventsInBatches(aggregateId, options);
    } else {
      // For PostgreSQL - use cursor-based streaming for better memory efficiency
      const qb = repo
        .createQueryBuilder('e')
        .where('e.version > :version', { version: version ?? 0 })
        .addOrderBy('e.version', 'ASC');

      if (blockHeight != null) {
        qb.andWhere('e.blockHeight <= :bh', { bh: blockHeight });
      }
      if (status != null) {
        qb.andWhere('e.status = :status', { status });
      }
      if (offset != null) {
        qb.skip(offset);
      }
      if (limit != null) {
        qb.take(limit);
      }

      const stream: Readable = await qb.stream();

      try {
        for await (const raw of stream) {
          // deserialize() handles decompression internally
          const historyEvent = await deserialize(aggregateId, raw, this.dbDriver);
          yield historyEvent.event;
        }
      } finally {
        stream.destroy();
      }
    }
  }

  public async *streamEventsForManyAggregates(
    aggregateIds: string[],
    options: FindEventsOptions = {}
  ): AsyncGenerator<BasicEvent<EventBasePayload>, void, unknown> {
    // Stream from each aggregate sequentially to maintain order
    for (const aggregateId of aggregateIds) {
      yield* this.streamEventsForOneAggregate(aggregateId, options);
    }
  }

  private async *streamEventsInBatches(
    aggregateId: string,
    options: FindEventsOptions,
    batchSize = 5000
  ): AsyncGenerator<BasicEvent<EventBasePayload>, void, unknown> {
    const { version, blockHeight, status, limit, offset } = options;
    const repo = this.getRepository(aggregateId);

    let currentOffset = offset ?? 0;
    let remainingLimit = limit;
    let hasMore = true;

    while (hasMore) {
      const currentBatchSize = remainingLimit ? Math.min(batchSize, remainingLimit) : batchSize;

      const qb = repo
        .createQueryBuilder('e')
        .where('e.version > :version', { version: version ?? 0 })
        .addOrderBy('e.version', 'ASC')
        .skip(currentOffset)
        .take(currentBatchSize);

      if (blockHeight != null) {
        qb.andWhere('e.blockHeight <= :bh', { bh: blockHeight });
      }
      if (status != null) {
        qb.andWhere('e.status = :status', { status });
      }

      const rawEvents = await qb.getMany();

      if (rawEvents.length === 0) {
        hasMore = false;
        break;
      }

      // Yield events one by one after processing
      for (const raw of rawEvents) {
        // SQLite doesn't compress payloads, but deserialize() handles both cases
        const historyEvent = await deserialize(aggregateId, raw, this.dbDriver);
        yield historyEvent.event;
      }

      currentOffset += rawEvents.length;
      if (remainingLimit) {
        remainingLimit -= rawEvents.length;
        if (remainingLimit <= 0) hasMore = false;
      }

      if (rawEvents.length < currentBatchSize) {
        hasMore = false;
      }
    }
  }

  public async getOneSnapshotByHeight<K extends T>(model: K, blockHeight: number): Promise<SnapshotParameters> {
    const { aggregateId } = model;
    if (!aggregateId) {
      throw new Error('Model does not have aggregateId');
    }

    // IMPORTANT: Cache is not used for specific blockHeight requests
    // Cache only stores the latest state of aggregates

    // IMPORTANT: Find the latest snapshot before or at the requested blockHeight
    const snapshot = await this.findLatestSnapshotBeforeHeight(aggregateId, blockHeight);

    // Two scenarios:
    //  a) There is no snapshot or it is "higher" than the required height — rebuild from scratch
    //  b) There is a snapshot "lower" than the required height — hydrate and catch up
    if (!snapshot) {
      // No snapshot found - rebuild from scratch
      this.log.debug('No snapshot found, rebuilding from scratch', { args: { aggregateId, blockHeight } });
      await this.applyEvents(model, blockHeight);
    } else if (snapshot.blockHeight < blockHeight) {
      // Found snapshot is older - hydrate and catch up
      this.log.debug('Hydrating from snapshot then catching up', {
        args: { aggregateId, snapshotHeight: snapshot.blockHeight, targetHeight: blockHeight },
      });

      // fromSnapshot() handles decompression internally and returns object
      const decompressedSnapshot = await fromSnapshot(snapshot, this.dbDriver);

      // Aggregate receives object directly in loadFromSnapshot
      model.loadFromSnapshot(decompressedSnapshot);
      await this.applyEvents(model, blockHeight);
    } else {
      // Exact match
      this.log.debug('Exact snapshot matches blockHeight', { args: { aggregateId, blockHeight } });

      // fromSnapshot() handles decompression internally and returns object
      const decompressedSnapshot = await fromSnapshot(snapshot, this.dbDriver);

      // Aggregate receives object directly in loadFromSnapshot
      model.loadFromSnapshot(decompressedSnapshot);
    }

    return toSnapshot(model as any, this.dbDriver);
  }

  public async getManySnapshotByHeight<K extends T>(models: K[], blockHeight: number): Promise<SnapshotParameters[]> {
    const result = await Promise.all(models.map((model) => this.getOneSnapshotByHeight(model, blockHeight)));
    return result;
  }

  // IMPORTANT: method to find the latest snapshot before or at given blockHeight
  private async findLatestSnapshotBeforeHeight(
    aggregateId: string,
    blockHeight: number
  ): Promise<SnapshotInterface | null> {
    const snapshotRepo = this.getRepository<SnapshotInterface>('snapshots');

    const snapshot = await snapshotRepo
      .createQueryBuilder('s')
      .where('s.aggregateId = :aggregateId', { aggregateId })
      .andWhere('s.blockHeight <= :blockHeight', { blockHeight })
      .orderBy('s.blockHeight', 'DESC')
      .limit(1)
      .getOne();

    return snapshot;
  }

  private async applyEvents<K extends T>(model: K, toHeight: number) {
    const args = { model, blockHeight: toHeight };
    if (this.isSqlite) {
      this.log.debug('Using SQLite batch processing for events', {
        args: { aggregateId: model.aggregateId },
      });
      await this._applyEventsInBatches(args);
    } else {
      this.log.debug('Using PostgreSQL streaming for events', {
        args: { aggregateId: model.aggregateId },
      });
      await this._applyEventsStreamToAggregate(args);
    }
  }

  private async _applyEventsStreamToAggregate({
    model,
    blockHeight,
    lastVersion = 0,
  }: {
    model: T;
    blockHeight?: number;
    lastVersion?: number;
  }): Promise<T> {
    if (this.isSqlite) {
      throw new Error('Stream is not supported by this database driver.');
    }

    const repository = this.getRepository(model.aggregateId);

    const queryBuilder = repository
      .createQueryBuilder('e')
      .select([
        'e.version      AS version',
        `e.requestId    AS "requestId"`,
        'e.status       AS status',
        'e.type         AS type',
        'e.payload      AS payload',
        `e.blockHeight  AS "blockHeight"`,
        'e.isCompressed AS "isCompressed"',
      ])
      .where({
        version: MoreThan(lastVersion),
        ...(blockHeight !== undefined ? { blockHeight: LessThanOrEqual(blockHeight) } : {}),
      })
      .orderBy('version', 'ASC');

    const stream: Readable = await queryBuilder.stream();

    try {
      for await (const row of stream) {
        // deserialize() handles decompression internally
        const historyEvent = await deserialize(model.aggregateId, row, this.dbDriver);
        await model.loadFromHistory([historyEvent]);
      }
      return model;
    } finally {
      stream.destroy();
    }
  }

  private async _applyEventsInBatches({
    model,
    blockHeight,
    lastVersion = 0,
    batchSize = 5000,
  }: {
    model: T;
    blockHeight?: number;
    lastVersion?: number;
    batchSize?: number;
  }): Promise<void> {
    let hasMore = true;

    const repository = this.getRepository(model.aggregateId);

    while (hasMore) {
      const eventRaws = await repository.find({
        where: {
          version: MoreThan(lastVersion),
          ...(blockHeight !== undefined ? { blockHeight: LessThanOrEqual(blockHeight) } : {}),
        },
        order: {
          version: 'ASC',
        },
        take: batchSize,
      });

      if (eventRaws.length === 0) {
        hasMore = false;
        break;
      }

      // deserialize() handles decompression internally
      const historyEvents = await Promise.all(
        eventRaws.map((raw: EventDataParameters) => deserialize(model.aggregateId, raw, this.dbDriver))
      );

      await model.loadFromHistory(historyEvents);

      lastVersion = eventRaws[eventRaws.length - 1].version;

      // If the number of loaded events is less than the batch size, then there is no more data
      if (eventRaws.length < batchSize) {
        hasMore = false;
      }
    }
  }

  // Get cache statistics for monitoring and debugging
  getCacheStats() {
    return this._cache.getStats();
  }

  // Get compression statistics for monitoring
  getCompressionStats() {
    return CompressionMetrics.getMetrics();
  }
}
