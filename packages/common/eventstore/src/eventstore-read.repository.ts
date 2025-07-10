import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { Repository, MoreThan, LessThanOrEqual, DataSource } from 'typeorm';
import type { ObjectLiteral } from 'typeorm';
import { AggregateRoot, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { EventDataParameters, deserialize } from './event-data.model';
import { toSnapshot, SnapshotInterface, SnapshotParameters } from './snapshots.model';

type FindEventsOptions = {
  version?: number;
  blockHeight?: number;
  status?: string;
  limit?: number;
  offset?: number;
};

class MemoryCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private defaultTTL: number;

  constructor(defaultTTL: number) {
    this.defaultTTL = defaultTTL;
  }

  get(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  set(key: string, value: T, ttl?: number): void {
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    this.cache.set(key, { value, expiresAt });
  }

  clear(key: string): void {
    this.cache.delete(key);
  }
}

@Injectable()
export class EventStoreReadRepository<T extends AggregateRoot = AggregateRoot> {
  private _cache = new MemoryCache<T>(60000); // TTL 60 seconds
  private isSqlite: boolean;

  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource,
    config: {}
  ) {
    this.isSqlite = this.dataSource.options.type === 'sqlite';
  }

  get cache() {
    return this._cache;
  }

  public async applyEventsInBatches(options: any) {
    return this._applyEventsInBatches(options);
  }

  public async applyEventsStreamToAggregate(options: any) {
    return this._applyEventsStreamToAggregate(options);
  }

  private getRepository<T extends ObjectLiteral = any>(aggregtaeId: string): Repository<T> {
    const entityMetadata = this.dataSource.entityMetadatasMap.get(aggregtaeId);

    if (!entityMetadata) {
      throw new Error(`Entity with name "${aggregtaeId}" not found.`);
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

    // TODO: think if we realy need this
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

    const events = rawEvents.map((raw) => deserialize(aggregateId, raw).event);
    this.log.debug('Deserialized events', { args: { deserializedCount: events.length } });

    return events;
  }

  public async *streamEventsForOneAggregate(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): AsyncGenerator<BasicEvent<EventBasePayload>, void, unknown> {
    const { version, blockHeight, status, limit, offset } = options;
    const repo = this.getRepository(aggregateId);

    if (this.isSqlite) {
      // For SQLite - use batch streaming
      yield* this.streamEventsInBatches(aggregateId, options);
    } else {
      // For other DBs - use native streaming
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
          yield deserialize(aggregateId, raw).event;
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

      // Yield events one by one
      for (const raw of rawEvents) {
        yield deserialize(aggregateId, raw).event;
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

    const cached = this._cache.get(aggregateId);
    if (cached && cached.lastBlockHeight === blockHeight) {
      this.log.debug('Returning snapshot from cache', { args: { aggregateId } });
      return toSnapshot(cached as any);
    }

    const snapshotRepo = this.getRepository<SnapshotInterface>('snapshots');
    const snapshot = await snapshotRepo.findOneBy({ aggregateId });

    // Two scenarios:
    //  a) There is no snapshot or it is “higher” than the required height — rebuild from scratch
    //  b) There is a snapshot “lower” than the required height — hydrate and catch up
    if (!snapshot || snapshot.blockHeight > blockHeight) {
      this.log.debug('Rebuilding from scratch', { args: { aggregateId } });
      await this.applyEvents(model, blockHeight);
    } else if (snapshot.blockHeight < blockHeight) {
      this.log.debug('Hydrating from snapshot then catching up', { args: { aggregateId } });
      model.loadFromSnapshot(snapshot);
      await this.applyEvents(model, blockHeight);
    } else {
      this.log.debug('Exact snapshot matches blockHeight', { args: { aggregateId } });
      return snapshot;
    }

    return toSnapshot(model as any);
  }

  public async getManySnapshotByHeight<K extends T>(models: K[], blockHeight: number): Promise<SnapshotParameters[]> {
    const result = await Promise.all(models.map((model) => this.getOneSnapshotByHeight(model, blockHeight)));
    return result;
  }

  private async applyEvents<K extends T>(model: K, toHeight: number) {
    const args = { model, blockHeight: toHeight };
    if (this.isSqlite) {
      this.log.warn('Using SQLite - may consume more memory for large datasets', {
        args: { aggregateId: model.aggregateId },
      });
      await this._applyEventsInBatches(args);
    } else {
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
      ])
      .where({
        version: MoreThan(lastVersion),
        ...(blockHeight !== undefined ? { blockHeight: LessThanOrEqual(blockHeight) } : {}),
      })
      .orderBy('version', 'ASC');

    const stream: Readable = await queryBuilder.stream();

    try {
      for await (const row of stream) {
        await model.loadFromHistory([deserialize(model.aggregateId, row)]);
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

      await model.loadFromHistory(eventRaws.map((raw: EventDataParameters) => deserialize(model.aggregateId, raw)));

      lastVersion = eventRaws[eventRaws.length - 1].version;

      // If the number of loaded events is less than the batch size, then there is no more data
      if (eventRaws.length < batchSize) {
        hasMore = false;
      }
    }
  }
}
