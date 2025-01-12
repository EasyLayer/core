import { Readable } from 'stream';
import { PostgresError } from 'pg-error-enum';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Repository, QueryFailedError, MoreThan, DataSource } from 'typeorm';
import { runInTransaction, Propagation, IsolationLevel, deleteDataSourceByName } from 'typeorm-transactional';
import { AggregateRoot, IEvent } from '@easylayer/components/cqrs';
import { AppLogger } from '@easylayer/components/logger';
import { EventDataModel } from './event-data.model';
import { SnapshotsModel } from './snapshots.model';

type AggregateWithId = AggregateRoot & { aggregateId: string };

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
export class EventStoreRepository<T extends AggregateWithId = AggregateWithId> implements OnModuleDestroy {
  private cache = new MemoryCache<T>(60000); // TTL 60 seconds
  private isStreamSupport: boolean;

  constructor(
    private readonly log: AppLogger,
    private readonly eventsRepository: Repository<EventDataModel>,
    private readonly snapshotsRepository: Repository<SnapshotsModel>,
    private readonly dataSource: DataSource,
    private readonly dataSourceName: string
  ) {
    this.isStreamSupport = this.eventsRepository.manager.connection?.options?.type === 'postgres';
  }

  async onModuleDestroy() {
    if (this.dataSource.isInitialized) {
      try {
        // TODO: temporary solution
        // Transactional Context is launched within the process, not the application.
        // So if we want it to be available only within the application, we must take care of its destruction.
        // Now we do it here, but it is better to move all this to a module.
        if (this.dataSource.options?.name) {
          deleteDataSourceByName(this.dataSource.options.name);
        }

        await this.dataSource.destroy();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {}
    }
  }

  public async save(models: T | T[]): Promise<void> {
    const aggregates: T[] = Array.isArray(models) ? models : [models];

    await runInTransaction(
      async () => {
        await Promise.all(aggregates.map((aggregate: T) => this.storeEvent(aggregate)));
      },
      {
        connectionName: this.dataSourceName,
        propagation: Propagation.REQUIRED,
        isolationLevel: IsolationLevel.SERIALIZABLE,
      }
    );

    // IMPORTANT: This is an events publish transaction
    // This transaction's error should not be thrown (if there is an error, these events will be published next time).
    // This logic is defined in the save() method
    // because it allows us to immediately use commit() of the aggregates, without an additional visit to the database.
    // The publication logic implies publishing events immediately and then updating the event status in the database.
    // In case of an update error in the database, these events will be published next time.
    await this.commit(aggregates);
  }

  private async commit(aggregates: T[]): Promise<void> {
    await runInTransaction(
      async () => {
        await Promise.all(aggregates.map((aggregate: T) => aggregate.commit()));
        await Promise.all(aggregates.map((aggregate: T) => this.setPublishStatuses(aggregate)));

        // Update cache
        aggregates.forEach((aggregate: T) => this.cache.set(aggregate.aggregateId, aggregate));
      },
      {
        connectionName: this.dataSourceName,
        propagation: Propagation.REQUIRED,
        isolationLevel: IsolationLevel.SERIALIZABLE,
      }
    ).catch((error) => {
      this.log.debug('commit() transaction', { error }, this.constructor.name);
      // Clear cache if error
      aggregates.forEach((aggregate: T) => this.cache.clear(aggregate.aggregateId));
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    await Promise.all(aggregates.map((aggregate: T) => this.updateSnapshot(aggregate))).catch((error) => {});
  }

  public async getOne(model: T): Promise<T> {
    // IMPORTANT: We have to go over the model of the unit here even if it is empty
    const { aggregateId } = model;

    if (!aggregateId) {
      return model;
    }

    const cachedModel = this.cache.get(aggregateId);

    if (cachedModel) {
      return cachedModel;
    }

    const snapshot = await this.snapshotsRepository.findOneBy({ aggregateId });

    if (!snapshot) {
      if (this.isStreamSupport) {
        await this.applyEventsStreamToAggregate(model, aggregateId);
      } else {
        await this.applyEventsInBatches(model, aggregateId);
      }

      return model;
    }

    // If the snapshot was in the database,
    // then we still need to check
    // its relevance by getting events according to a version higher than that of the snapshot.
    model.loadFromSnapshot(snapshot);

    if (this.isStreamSupport) {
      await this.applyEventsStreamToAggregate(model, aggregateId, model.version);
    } else {
      await this.applyEventsInBatches(model, aggregateId, model.version);
    }

    return model;
  }

  private async setPublishStatuses(aggregate: T) {
    try {
      const { aggregateId } = aggregate;

      await this.eventsRepository
        .createQueryBuilder()
        .update(EventDataModel)
        .set({ isPublished: true })
        .where('aggregateId = :aggregateId', { aggregateId })
        .andWhere('isPublished = :isPublished', { isPublished: false })
        .execute();
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError;

        if (driverError.code === 'SQLITE_CONSTRAINT') {
          this.log.error('updateStatuses()', { error: driverError.message }, this.constructor.name);
          return;
        }

        if (driverError.code === PostgresError.UNIQUE_VIOLATION) {
          this.log.error('updateStatuses()', { error: driverError.detail }, this.constructor.name);
          return;
        }

        throw error;
      }

      this.log.error('updateStatuses()', { error }, this.constructor.name);
      throw error;
    }
  }

  private async storeEvent(aggregate: T) {
    try {
      const uncommittedEvents: IEvent[] = aggregate.getUncommittedEvents();

      if (uncommittedEvents.length === 0) {
        return;
      }

      const events = uncommittedEvents.map((event) => {
        return EventDataModel.serialize(event, aggregate.version);
      });

      // IMPORTANT: We use createQueryBuilder with "updateEntity = false" option to ensure there is only one query
      // (without select after insert)
      // https://github.com/typeorm/typeorm/issues/4651
      await this.eventsRepository.createQueryBuilder().insert().values(events).updateEntity(false).execute();

      this.cache.set(aggregate.aggregateId, aggregate);
    } catch (error) {
      try {
        this.handleDatabaseError(error, aggregate);
      } catch (e) {
        this.cache.clear(aggregate.aggregateId);
      }
    }
  }

  private async updateSnapshot(aggregate: T) {
    try {
      // Update snapshot only when version is a multiple of 50
      if (aggregate.version % 50 !== 0) {
        return;
      }

      // Serialize the cloned aggregate
      const snapshot = SnapshotsModel.toSnapshot(aggregate);

      await this.snapshotsRepository
        .createQueryBuilder()
        .insert()
        .into(SnapshotsModel)
        .values(snapshot)
        .orUpdate(
          ['payload'], // Columns that we update
          ['aggregateId']
        )
        .updateEntity(false)
        .execute();
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError;

        if (driverError.code === 'SQLITE_CONSTRAINT') {
          this.log.error('updateSnapshot()', { error: driverError.message }, this.constructor.name);
          return;
        }

        if (driverError.code === PostgresError.UNIQUE_VIOLATION) {
          this.log.error('updateSnapshot()', { error: driverError.detail }, this.constructor.name);
          return;
        }

        throw error;
      }

      this.log.error('updateSnapshot()', { error }, this.constructor.name);

      throw error;
    }
  }

  private async applyEventsStreamToAggregate(model: T, aggregateId: string, lastVersion: number = 0): Promise<T> {
    if (!this.isStreamSupport) {
      throw new Error('Stream is not supported by this database driver.');
    }

    return new Promise<T>(async (resolve, reject) => {
      const queryBuilder = this.eventsRepository
        .createQueryBuilder('event')
        .where('event.aggregateId = :aggregateId', { aggregateId })
        .andWhere('event.version > :lastVersion', { lastVersion })
        .orderBy('event.version', 'ASC');

      const stream: Readable = await queryBuilder.stream();

      stream.on('data', async (eventRaw: EventDataModel) => {
        await model.loadFromHistory([EventDataModel.deserialize(eventRaw)]);
      });

      stream.on('end', () => {
        resolve(model);
      });

      stream.on('error', (error: any) => {
        reject(error);
      });
    });
  }

  private async applyEventsInBatches(
    model: T,
    aggregateId: string,
    lastVersion: number = 0,
    batchSize: number = 1000
  ): Promise<void> {
    let hasMore = true;
    let currentLastVersion = lastVersion;

    while (hasMore) {
      const eventRaws = await this.eventsRepository.find({
        where: {
          aggregateId,
          version: MoreThan(currentLastVersion),
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

      await model.loadFromHistory(eventRaws.map(EventDataModel.deserialize));

      const lastEvent = eventRaws[eventRaws.length - 1];
      if (lastEvent) {
        currentLastVersion = lastEvent.version;
      }

      // If the number of loaded events is less than the batch size, then there is no more data
      if (eventRaws.length < batchSize) {
        hasMore = false;
      }
    }
  }

  private handleDatabaseError(error: any, aggregate: T): void {
    if (error instanceof QueryFailedError) {
      const driverError = error.driverError;

      // SQLite Error Handling
      if (driverError.code === 'SQLITE_CONSTRAINT') {
        const errorMessage = driverError.message;
        if (errorMessage.includes('UNIQUE constraint failed: events.requestId, events.aggregateId')) {
          this.log.debug('SQLITE_CONSTRAINT: Idempotency protection', null, this.constructor.name);
          aggregate.uncommit();
          return;
        }
        if (errorMessage.includes('UNIQUE constraint failed: events.version, events.aggregateId')) {
          throw new Error('Version conflict error');
        }

        switch (driverError.message) {
          case 'UQ__request_id__aggregate_id':
            this.log.debug('SQLITE_CONSTRAINT: Idempotency protection', null, this.constructor.name);
            aggregate.uncommit();
            return;
          case 'UQ__version__aggregate_id':
            throw new Error('Version conflict error');
          default:
            throw error;
        }
      }

      // PostgreSQL Error Handling
      if (driverError.code === PostgresError.UNIQUE_VIOLATION) {
        if (driverError.detail.includes('Key (request_id, aggregate_id)')) {
          this.log.debug('POSTGRES_CONSTRAINT: Idempotency protection', null, this.constructor.name);
          aggregate.uncommit();
          return;
        }
        if (driverError.detail.includes('Key (version, aggregate_id)')) {
          throw new Error('Version conflict error');
        }
        throw error;
      }

      throw error;
    }
  }
}
