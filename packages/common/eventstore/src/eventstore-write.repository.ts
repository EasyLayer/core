import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { PostgresError } from 'pg-error-enum';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { QueryFailedError, DataSource } from 'typeorm';
import type { QueryRunner, Repository, ObjectLiteral } from 'typeorm';
import { runInTransaction, Propagation, IsolationLevel } from 'typeorm-transactional';
import { ExponentialTimer, exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { AggregateRoot, EventStatus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { ContextService } from '@easylayer/common/context';
import { EventDataParameters, serialize } from './event-data.model';
import { toSnapshot } from './snapshots.model';
import { EventStoreReadRepository } from './eventstore-read.repository';

@Injectable()
export class EventStoreWriteRepository<T extends AggregateRoot = AggregateRoot> implements OnModuleDestroy {
  private isSqlite: boolean;
  private snapshotInterval: number = 50;
  private sqliteBatchSize: number = 999;
  private commitTimer: ExponentialTimer | null = null;

  constructor(
    private readonly log: AppLogger,
    private readonly ctxService: ContextService,
    private readonly dataSource: DataSource,
    private readonly dataSourceName: string,
    private readonly readRepository: EventStoreReadRepository,
    config: { sqliteBatchSize?: number; snapshotInterval?: number }
  ) {
    this.isSqlite = this.dataSource.options.type === 'sqlite';

    if (config.snapshotInterval) {
      this.snapshotInterval = config.snapshotInterval;
    }
    if (config.sqliteBatchSize) {
      this.sqliteBatchSize = config.sqliteBatchSize;
    }
  }

  async onModuleDestroy() {
    this.commitTimer?.destroy();
    this.commitTimer = null;
  }

  private getRepository<T extends ObjectLiteral = any>(aggregtaeId: string): Repository<T> {
    const entityMetadata = this.dataSource.entityMetadatasMap.get(aggregtaeId);

    if (!entityMetadata) {
      throw new Error(`Entity with name "${aggregtaeId}" not found.`);
    }

    return this.dataSource.getRepository<T>(entityMetadata.target);
  }

  public async save(models: T | T[]): Promise<void> {
    const aggregates: T[] = Array.isArray(models) ? models : [models];

    this.log.debug('Starting save operation', { args: { count: aggregates.length } });

    await runInTransaction(
      async () => {
        this.log.debug('Storing events for aggregates');
        await Promise.all(aggregates.map((aggregate: T) => this.storeEvents(aggregate)));
        this.log.debug('Events stored successfully');
      },
      {
        connectionName: this.dataSourceName,
        propagation: Propagation.REQUIRED,
        isolationLevel: IsolationLevel.SERIALIZABLE,
      }
    );

    this.log.debug('Invoking commit to publish events');

    // IMPORTANT: This is an events publish transaction
    // This transaction's error should not be thrown (if there is an error, these events will be published next time).
    // This logic is defined in the save() method
    // because it allows us to immediately use commit() of the aggregates, without an additional visit to the database.
    // The publication logic implies publishing events immediately and then updating the event status in the database.
    // In case of an update error in the database, these events will be published next time.
    await this.retryCommit(aggregates);
  }

  public async rollback({
    modelsToRollback,
    blockHeight,
    modelsToSave,
  }: {
    modelsToRollback: T[];
    blockHeight: number;
    modelsToSave?: T[];
  }): Promise<void> {
    if (!modelsToRollback.length) {
      this.log.debug('Nothing to rollback', { args: { blockHeight: modelsToRollback.length } });
      return;
    }

    this.log.debug('Starting rollback operation', {
      args: {
        toRollbackCount: modelsToRollback.length,
        blockHeight,
      },
    });

    const isExistModelsToSave = Array.isArray(modelsToSave) && modelsToSave.length > 0;

    await runInTransaction(
      async () => {
        this.log.debug('Deleting events to rollback');
        await Promise.all(modelsToRollback.map((aggregate: T) => this.deleteEvents(aggregate, blockHeight)));
        this.log.debug('Events deleted for rollback');

        // TODO: think how handle this, because currently this is not good
        if (isExistModelsToSave) {
          this.log.debug('Storing events for modelsToSave');
          await Promise.all(modelsToSave!.map((aggregate: T) => this.storeEvents(aggregate)));
          this.log.debug('Events stored for modelsToSave');
        }

        this.log.debug('Clearing cache for rolled back aggregates');

        // IMPORATANT: We can easily just clear the cache instead of restoring and overwriting it.
        // So next time the factory initializes the state it will create the cache itself.
        modelsToRollback.forEach((aggregate: T) => this.readRepository.cache.clear(aggregate.aggregateId));
        this.log.debug('Updating snapshots after rollback');

        this.log.debug('Snapshots updated after rollback');
        await Promise.all(
          modelsToRollback.map((aggregate: T) => this.onRollbackUpdateSnapshot(aggregate, blockHeight))
        );
      },
      {
        // TODO: think about isolation in this rollback method
        connectionName: this.dataSourceName,
        propagation: Propagation.REQUIRED,
        isolationLevel: IsolationLevel.SERIALIZABLE,
      }
    );

    if (isExistModelsToSave) {
      this.log.debug('Invoking commit for modelsToSave after rollback', { args: { toSaveCount: modelsToSave.length } });
      await this.retryCommit(modelsToSave!);
      this.log.debug('Commit returned for modelsToSave');

      // TODO: think, do we really need this in the rollback in save case?
      // await Promise.all(modelsToSave!.map((aggregate: T) => this.onSaveUpdateSnapshot(aggregate)));
    }
  }

  public async getOne<K extends T>(model: K): Promise<K> {
    // IMPORTANT: We have to go over the model of the unit here even if it is empty
    const { aggregateId } = model;

    if (!aggregateId) {
      return model;
    }

    const cachedModel = this.readRepository.cache.get(aggregateId) as K;

    if (cachedModel) {
      return cachedModel;
    }

    const snapshotRepo = this.getRepository('snapshots');

    const snapshot = await snapshotRepo.findOneBy({ aggregateId });

    if (!snapshot) {
      if (this.isSqlite) {
        await this.readRepository.applyEventsInBatches({ model });
      } else {
        await this.readRepository.applyEventsStreamToAggregate({ model });
      }

      return model;
    }

    // If the snapshot was in the database,
    // then we still need to check
    // its relevance by getting events according to a version higher than that of the snapshot.
    model.loadFromSnapshot(snapshot);

    if (this.isSqlite) {
      await this.readRepository.applyEventsInBatches({ model, lastVersion: model.version });
    } else {
      await this.readRepository.applyEventsStreamToAggregate({ model, lastVersion: model.version });
    }

    return model;
  }

  private async commit(aggregates: T[]): Promise<void> {
    // We collect all requestId from unviewed events and remove duplicates
    const allRequestIds = aggregates.flatMap((a) => a.getUncommittedEvents().map((e) => e.payload.requestId as string));
    const batchRequestIds = Array.from(new Set(allRequestIds));

    // We launch a single "batch" context so that further down the flow
    // and in other modules, loggers understand which events are currently being processed
    await this.ctxService.run({ type: 'batch', batchRequestIds }, async () => {
      this.log.debug('Starting batch commit', { batchRequestIds });

      await runInTransaction(
        async () => {
          this.log.debug('Committing aggregates', { args: { count: aggregates.length } });
          await Promise.all(aggregates.map((a) => a.commit()));

          this.log.debug('Updating publish statuses');
          await Promise.all(aggregates.map((a) => this.setPublishStatuses(a)));

          // Refreshing the cache after a successful commit
          aggregates.forEach((a) => this.readRepository.cache.set(a.aggregateId, a));

          this.log.debug('Updating snapshots after commit');
          await Promise.all(aggregates.map((aggregate: T) => this.onSaveUpdateSnapshot(aggregate)));
          this.log.debug('Snapshots updated');
        },
        {
          connectionName: this.dataSourceName,
          propagation: Propagation.REQUIRED,
          isolationLevel: IsolationLevel.SERIALIZABLE,
        }
      );

      this.log.debug('Batch commit complete');
    });
  }

  // IMPORTANT: Retry logic was added as a fix for the issue when commit fails due to unpublihsed
  // events for the client and gets stuck because other systems remain blocked until successful publishing
  private async retryCommit(aggregates: T[]): Promise<void> {
    if (this.commitTimer) {
      this.commitTimer.destroy();
      this.commitTimer = null;
    }

    // IMPORTANT: Retry logic works only under specific conditions:
    // 1 - Next blocks won't start parsing until successful commit (to avoid cache update race conditions)
    // 2 - We don't track which aggregates are being committed, so we stop timer for all previous ones
    this.commitTimer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.commit(aggregates);
          this.commitTimer?.destroy();
          this.commitTimer = null;
        } catch (error) {
          this.log.debug('Batch commit transaction failed', {
            methodName: 'commit',
            args: { error },
          });
        }
      },
      {
        interval: 1000,
        multiplier: 2,
        maxInterval: 4000,
      }
    );
  }

  private async setPublishStatuses(aggregate: T) {
    try {
      const { aggregateId } = aggregate;

      const repository = this.getRepository(aggregateId);

      await repository
        .createQueryBuilder()
        .update()
        .set({ status: EventStatus.PUBLISHED })
        .where('status = :status', { status: EventStatus.UNPUBLISHED })
        .execute();
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError;

        if (driverError.code === 'SQLITE_CONSTRAINT') {
          this.log.debug('Publish status conflict, skipping (SQLite constraint)', {
            methodName: 'setPublishStatuses',
            args: { error: driverError.message },
          });
          return;
        }

        if (driverError.code === PostgresError.UNIQUE_VIOLATION) {
          this.log.debug('Publish status conflict, skipping (Postgres unique violation)', {
            methodName: 'setPublishStatuses',
            args: { error: driverError.detail },
          });
          return;
        }

        throw error;
      }
      throw error;
    }
  }

  // private async setReceivedStatuses(aggregate: T) {
  //   try {
  //     const { aggregateId } = aggregate;

  //     const repository = this.getRepository(aggregateId);

  //     await repository
  //       .createQueryBuilder()
  //       .update()
  //       .set({ status: EventStatus.RECEIVED })
  //       .where('status = :status', { status: EventStatus.PUBLISHED })
  //       .execute();
  //   } catch (error) {
  //     if (error instanceof QueryFailedError) {
  //       const driverError = error.driverError;

  //       if (driverError.code === 'SQLITE_CONSTRAINT') {
  //         this.log.warn('setReceivedStatuses()', { error: driverError.message }, this.constructor.name);
  //         return;
  //       }

  //       if (driverError.code === PostgresError.UNIQUE_VIOLATION) {
  //         this.log.warn('setReceivedStatuses()', { error: driverError.detail }, this.constructor.name);
  //         return;
  //       }

  //       throw error;
  //     }

  //     this.log.error('setReceivedStatuses()', { error }, this.constructor.name);
  //     throw error;
  //   }
  // }

  private async storeEvents(aggregate: T) {
    try {
      const unsavedEvents = aggregate.getUnsavedEvents();

      if (unsavedEvents.length === 0) {
        return;
      }

      const version = aggregate.version - unsavedEvents.length;
      const events = unsavedEvents.map((event, index) => {
        return serialize(event, version + index + 1);
      });

      const repository = this.getRepository(aggregate.aggregateId);

      if (this.isSqlite) {
        const batches = this.chunkArray(events, this.sqliteBatchSize);
        for (const batch of batches) {
          await this.insert(batch, repository);
        }
      } else {
        await this.insertWithCopy(events, repository);
      }

      // IMPORTANT: update cache as method getUnsavedEvents() was changed statuses
      this.readRepository.cache.set(aggregate.aggregateId, aggregate);
    } catch (error) {
      this.readRepository.cache.clear(aggregate.aggregateId);
      this.handleDatabaseError(error, aggregate);
    }
  }

  private async insert(events: EventDataParameters[], repository: Repository<EventDataParameters>) {
    // IMPORTANT: We use createQueryBuilder with "updateEntity = false" option to ensure there is only one query
    // (without select after insert)
    // https://github.com/typeorm/typeorm/issues/4651
    await repository.createQueryBuilder().insert().values(events).updateEntity(false).execute();
  }

  private async insertWithCopy(events: EventDataParameters[], repository: Repository<EventDataParameters>) {
    const queryRunner = repository.manager.queryRunner as QueryRunner | undefined;
    if (!queryRunner) {
      throw new Error('insertWithCopy must be called inside a transaction');
    }

    const meta = repository.metadata;
    const tableName = `"${meta.tableName}"`;
    const columns = meta.columns.map((c) => `"${c.databaseName}"`).join(', ');

    const stream = new Readable({
      read() {
        for (const row of events) {
          const line = meta.columns
            .map((col) => {
              const v = (row as any)[col.propertyName];
              if (v == null) return '\\N';
              const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
              return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
            })
            .join('\t');
          this.push(line + '\n');
        }
        this.push(null);
      },
    });

    const query = `COPY ${tableName} (${columns}) FROM STDIN WITH (FORMAT text)`;

    // https://github.com/typeorm/typeorm/issues/4839
    // Getting a low-level PostgreSQL client
    // const rawClient = await (<PostgresQueryRunner>queryRunner).connect();

    const rawClient = await (queryRunner as any).connect();
    if (!rawClient) {
      throw new Error('Failed to get low-level client from TypeORM.');
    }

    const copyStream = rawClient.query(copyFrom(query));

    // IMPORTANT: Using pipeline to handle async streams correctly
    await pipeline(stream, copyStream);
  }

  private async deleteEvents(aggregate: T, blockHeight: number) {
    const repository = this.getRepository(aggregate.aggregateId);
    await repository
      .createQueryBuilder()
      .delete()
      // IMPORTANT: should be '>'. We delete all events more then reorg height(which is last one corrected)
      .where('blockHeight > :blockHeight', { blockHeight })
      .execute();
  }

  private async onSaveUpdateSnapshot(aggregate: T) {
    try {
      if (aggregate.versionsFromSnapshot < this.snapshotInterval) {
        return;
      }

      // Serialize the cloned aggregate
      aggregate.resetSnapshotCounter();
      const snapshot = toSnapshot(aggregate as any);
      const repository = this.getRepository('snapshots');

      // IMPORTANT: we keep all snapshots instead of overwriting
      await repository.createQueryBuilder().insert().values(snapshot).updateEntity(false).execute();

      this.log.debug('Snapshot created', {
        args: {
          aggregateId: aggregate.aggregateId,
          blockHeight: aggregate.lastBlockHeight,
          version: aggregate.version,
        },
      });
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as any;
        const code = driverError.code;
        const msg = driverError.message ?? driverError.detail;

        if (code === 'SQLITE_CONSTRAINT' || code === PostgresError.UNIQUE_VIOLATION) {
          this.log.debug('Snapshot upsert conflict, skipping', {
            methodName: 'onSaveUpdateSnapshot',
            args: { error: msg },
          });
          return;
        }

        throw error;
      }

      this.log.debug('Error during snapshot updating', {
        methodName: 'onSaveUpdateSnapshot',
        args: { error },
      });
    }
  }

  private async onRollbackUpdateSnapshot(aggregate: T, blockHeight: number) {
    try {
      // IMPORTANT: Delete all snapshots with blockHeight >= rollback blockHeight
      // This ensures we don't have "future" snapshots after rollback
      await this.deleteSnapshotsAfterHeight(aggregate.aggregateId, blockHeight);

      this.log.debug('Snapshots cleaned after rollback', {
        args: {
          aggregateId: aggregate.aggregateId,
          blockHeight,
        },
      });
    } catch (error) {
      this.log.debug('Error during snapshot rollback', {
        methodName: 'onRollbackUpdateSnapshot',
        args: { error, blockHeight },
      });
    }
  }

  private async deleteSnapshotsAfterHeight(aggregateId: string, blockHeight: number) {
    const repository = this.getRepository('snapshots');

    await repository
      .createQueryBuilder()
      .delete()
      .where('aggregateId = :aggregateId', { aggregateId })
      .andWhere('blockHeight >= :blockHeight', { blockHeight })
      .execute();
  }

  private async deleteSnapshot(aggregate: T, blockHeight?: number) {
    const repository = this.getRepository('snapshots');
    const query = repository
      .createQueryBuilder()
      .delete()
      .where('aggregateId = :aggregateId', { aggregateId: aggregate.aggregateId });

    if (blockHeight !== undefined) {
      query.andWhere('blockHeight = :blockHeight', { blockHeight });
    }

    await query.execute();
  }

  private handleDatabaseError(error: any, aggregate: T): void {
    if (error instanceof QueryFailedError) {
      const driverError = error.driverError;

      // Too many variables (SQLite)
      if (driverError.code === 'SQLITE_ERROR') {
        const errorMessage = driverError.message;
        if (errorMessage.includes('too many SQL variables')) {
          throw new Error(`Batch insert failed: too many SQL variables`);
        }

        throw error;
      }

      // SQLite constraint → idempotency
      if (driverError.code === 'SQLITE_CONSTRAINT') {
        const errorMessage = driverError.message;
        if (
          errorMessage.includes(
            `UNIQUE constraint failed: ${aggregate.aggregateId}.version, ${aggregate.aggregateId}.requestId`
          )
        ) {
          this.log.debug('Idempotency: duplicate event — skipping', {
            methodName: 'handleDatabaseError',
          });
          aggregate.uncommit();
          return;
        }

        throw error;
      }

      // Postgres unique violation → idempotency
      if (driverError.code === PostgresError.UNIQUE_VIOLATION) {
        if (driverError.detail.includes('Key (version, request_id)')) {
          this.log.debug('Idempotency: duplicate event — skipping (Postgres)', {
            methodName: 'handleDatabaseError',
          });
          aggregate.uncommit();
          return;
        }

        throw error;
      }

      throw error;
    }
    throw error;
  }

  /**
   * Helper function to chunk large arrays into smaller batches.
   * Used primarily for batch inserts.
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const results: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      results.push(array.slice(i, i + chunkSize));
    }
    return results;
  }
}
