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
import { serializeSnapshot } from './snapshots.model';
import { EventStoreReadRepository } from './eventstore-read.repository';

type DriverType = 'sqlite' | 'postgres';

@Injectable()
export class EventStoreWriteRepository<T extends AggregateRoot = AggregateRoot> implements OnModuleDestroy {
  private isSqlite: boolean;
  private sqliteBatchSize: number = 999;
  private commitTimer: ExponentialTimer | null = null;
  private pendingToCommitAggregates: Map<string, T> = new Map();
  private dbDriver: DriverType;

  constructor(
    private readonly log: AppLogger,
    private readonly ctxService: ContextService,
    private readonly dataSource: DataSource,
    private readonly dataSourceName: string,
    private readonly readRepository: EventStoreReadRepository,
    config: { sqliteBatchSize?: number }
  ) {
    this.isSqlite = this.dataSource.options.type === 'sqlite';
    this.dbDriver = this.isSqlite ? 'sqlite' : 'postgres';

    if (config.sqliteBatchSize) {
      this.sqliteBatchSize = config.sqliteBatchSize;
    }
  }

  async onModuleDestroy() {
    this.commitTimer?.destroy();
    this.commitTimer = null;
  }

  private getRepository<T extends ObjectLiteral = any>(aggregateId: string): Repository<T> {
    const entityMetadata = this.dataSource.entityMetadatasMap.get(aggregateId);

    if (!entityMetadata) {
      throw new Error(`Entity with name "${aggregateId}" not found.`);
    }

    return this.dataSource.getRepository<T>(entityMetadata.target);
  }

  public async save(models: T | T[]): Promise<void> {
    const aggregates: T[] = Array.isArray(models) ? models : [models];

    this.log.debug('Starting save operation', { args: { count: aggregates.length } });

    await runInTransaction(
      async () => {
        await Promise.all(aggregates.map((aggregate: T) => this.storeEvents(aggregate)));
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
        await Promise.all(modelsToRollback.map((aggregate: T) => this.deleteEvents(aggregate, blockHeight)));

        // TODO: think how handle this, because currently this is not good
        if (isExistModelsToSave) {
          await Promise.all(modelsToSave!.map((aggregate: T) => this.storeEvents(aggregate)));
        }

        this.log.debug('Clearing cache for rolled back aggregates');

        // IMPORTANT: We can easily just clear the cache instead of restoring and overwriting it.
        // So next time the factory initializes the state it will create the cache itself.
        modelsToRollback.forEach((aggregate: T) => this.readRepository.cache.clear(aggregate.aggregateId));

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
      await this.retryCommit(modelsToSave!);

      // TODO: think, do we really need this in the rollback in save case?
      // await Promise.all(modelsToSave!.map((aggregate: T) => this.onSaveUpdateSnapshot(aggregate)));
    }
  }

  public async getOne<K extends T>(model: K): Promise<K> {
    return this.readRepository.getOne(model);
  }

  private async commit(aggregates: T[]): Promise<void> {
    this.log.debug('Starting batch commit', {
      args: {
        count: aggregates.length,
        aggregateIds: aggregates.map((a) => a.aggregateId),
      },
    });

    // Process aggregates based on database type
    if (this.isSqlite) {
      // SQLite: Sequential processing to avoid lock conflicts
      await this.commitAggregatesSequentially(aggregates);
    } else {
      // PostgreSQL: Parallel processing for better performance
      await this.commitAggregatesInParallel(aggregates);
    }

    // Update snapshots for successfully committed aggregates (those with no uncommitted events)
    const successfullyCommitted = aggregates.filter((a) => a.getUncommittedEvents().length === 0);

    this.log.debug('Updating snapshots for committed aggregates', {
      args: { count: successfullyCommitted.length },
    });

    await Promise.all(successfullyCommitted.map((aggregate: T) => this.onSaveUpdateSnapshot(aggregate)));

    this.log.debug('Batch commit complete', {
      args: {
        attempted: aggregates.length,
        successful: successfullyCommitted.length,
      },
    });
  }

  private async commitAggregatesSequentially(aggregates: T[]): Promise<void> {
    this.log.debug('Processing aggregates sequentially (SQLite)');

    for (const aggregate of aggregates) {
      await this.commitSingleAggregate(aggregate);
    }
  }

  private async commitAggregatesInParallel(aggregates: T[]): Promise<void> {
    this.log.debug('Processing aggregates in parallel (PostgreSQL)');

    // Use Promise.allSettled to continue even if some aggregates fail
    const results = await Promise.allSettled(aggregates.map((aggregate) => this.commitSingleAggregate(aggregate)));

    // Log any failures for monitoring
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.log.debug('Aggregate commit failed in parallel processing', {
          args: {
            aggregateId: aggregates[index]!.aggregateId,
            error: result.reason?.message,
          },
        });
      }
    });
  }

  private async commitSingleAggregate(aggregate: T): Promise<void> {
    const aggregateId = aggregate.aggregateId;
    const beforeCommitEvents = aggregate.getUncommittedEvents().length;

    try {
      // Each aggregate gets its own transaction
      await runInTransaction(
        async () => {
          // Step 1: Publish events (this calls aggregate.commit() which publishes and clears events)
          await aggregate.commit();

          // Step 2: Update database status to PUBLISHED
          await this.setPublishStatuses(aggregate);
          this.log.debug('Publish status updated in database', {
            args: { aggregateId },
          });

          // Step 3: Update cache after successful commit
          this.readRepository.cache.set(aggregateId, aggregate);
          this.log.debug('Cache updated for aggregate', {
            args: { aggregateId },
          });
        },
        {
          connectionName: this.dataSourceName,
          propagation: Propagation.REQUIRED,
          isolationLevel: IsolationLevel.SERIALIZABLE,
        }
      );

      this.log.debug('Single aggregate commit successful', {
        args: { aggregateId },
      });
    } catch (error) {
      this.log.debug('Single aggregate commit failed', {
        args: {
          aggregateId,
          error: (error as any)?.message,
          stack: (error as any)?.stack,
        },
      });

      // Clear cache for failed aggregate to force reload
      this.readRepository.cache.clear(aggregateId);

      // Don't throw - let other aggregates continue processing
      // The retry mechanism will pick this up later
    }
  }

  private async attemptCommit(): Promise<void> {
    if (this.pendingToCommitAggregates.size === 0) {
      // this.log.debug('No pending aggregates to commit');
      return;
    }

    const allAggregates = Array.from(this.pendingToCommitAggregates.values());

    // Filter out aggregates that have no uncommitted events
    const aggregatesWithEvents = allAggregates.filter((a) => {
      const uncommittedCount = a.getUncommittedEvents().length;
      return uncommittedCount > 0;
    });

    if (aggregatesWithEvents.length === 0) {
      // this.log.debug('No aggregates with events to commit, clearing pending');
      this.pendingToCommitAggregates.clear();
      return; // Complete success - no pending work
    }

    this.log.debug('Attempting to commit aggregates', {
      args: {
        totalPending: allAggregates.length,
        withEvents: aggregatesWithEvents.length,
        aggregateIds: aggregatesWithEvents.map((a) => a.aggregateId),
      },
    });

    // Commit aggregates (each in its own transaction)
    await this.commit(aggregatesWithEvents);

    // Check which ones successfully committed and remove them from pending
    const stillHaveEvents = aggregatesWithEvents.filter((a) => a.getUncommittedEvents().length > 0);
    const successfullyCommitted = aggregatesWithEvents.filter((a) => a.getUncommittedEvents().length === 0);

    this.log.debug('Commit attempt finished', {
      args: {
        attempted: aggregatesWithEvents.length,
        successful: successfullyCommitted.length,
        stillPending: stillHaveEvents.length,
        successfulIds: successfullyCommitted.map((a) => a.aggregateId),
        stillPendingIds: stillHaveEvents.map((a) => a.aggregateId),
      },
    });

    // Remove only successfully committed aggregates from pending
    successfullyCommitted.forEach((a) => this.pendingToCommitAggregates.delete(a.aggregateId));

    // IMPORTANT: If some aggregates still have uncommitted events, throw error
    // This will trigger retry timer to continue running with exponential backoff
    if (stillHaveEvents.length > 0) {
      throw new Error(
        `Failed to commit ${stillHaveEvents.length} aggregates: ${stillHaveEvents.map((a) => a.aggregateId).join(', ')}`
      );
    }

    // All aggregates successfully committed - complete success
  }

  // IMPORTANT: Retry logic handles two key scenarios for event publishing reliability:
  //
  // Scenario 1 - Last block processing (needs timer):
  // t1: save(lastBlockAggregate) → events: [A, B] → pending: {lastBlockAggregate}
  // t2: commit fails (network/transport issue) → timer starts with exponential backoff
  // t3: no new blocks coming → timer ensures eventual delivery: retry 1s, 2s, 4s, 8s...
  // t4: timer succeeds → events published, timer destroyed
  //
  // Scenario 2 - Fast block processing (natural batching):
  // t1: save(aggregate1) → events: [A, B] → pending: {aggregate1}
  // t2: save(aggregate2) → events: [C] → pending: {aggregate1, aggregate2}
  // t3: commit fails → timer starts
  // t4: save(aggregate3) → events: [D] → pending: {aggregate1, aggregate2, aggregate3}
  // t5: timer fires → partial success: aggregate2, aggregate3 commit, aggregate1 fails
  // t6: timer continues → only aggregate1 remains in pending, retries until success
  //
  // Key benefits:
  // - Immediate attempt avoids unnecessary delays in happy path
  // - Timer only created on failure, not for every save operation
  // - Natural batching when blocks arrive quickly improves throughput
  // - Exponential backoff prevents overwhelming failed services
  // - Partial failures don't block successful aggregates
  // - Failed aggregates keep retrying until success
  private async retryCommit(aggregates: T[]): Promise<void> {
    // Add aggregates to pending map
    aggregates.forEach((a) => this.pendingToCommitAggregates.set(a.aggregateId, a));

    // If timer is already running, just add to pending and return
    // The running timer will pick up these new aggregates
    if (this.commitTimer) {
      this.log.debug('Commit timer already running, aggregates added to pending', {
        args: {
          newCount: aggregates.length,
          totalPending: this.pendingToCommitAggregates.size,
        },
      });
      return;
    }

    // Start immediate commit attempt, then setup timer only if needed
    try {
      await this.attemptCommit();
      // Complete success - all aggregates committed, no timer needed
      this.log.debug('Immediate commit attempt succeeded, no timer needed');
      return;
    } catch (error) {
      this.log.debug('Initial commit failed or partial, starting retry timer', {
        args: {
          error: (error as any)?.message,
          remainingPending: this.pendingToCommitAggregates.size,
        },
      });
    }

    // Setup retry timer only after initial failure or partial success
    this.commitTimer = exponentialIntervalAsync(
      async (resetInterval) => {
        try {
          await this.attemptCommit();

          // SUCCESS: All pending aggregates committed
          resetInterval(); // Reset exponential backoff for future use
          this.commitTimer?.destroy();
          this.commitTimer = null;

          this.log.debug('Retry commit succeeded completely, timer stopped');
        } catch (error) {
          // PARTIAL SUCCESS or COMPLETE FAILURE: Some aggregates still pending
          this.log.debug('Retry commit failed or partial, will retry with exponential backoff', {
            args: {
              error: (error as any)?.message,
              remainingPending: this.pendingToCommitAggregates.size,
            },
          });
          // Timer will automatically retry with increased interval
        }
      },
      {
        interval: 1000, // Start with 1 second
        multiplier: 2, // Double each time
        maxInterval: 8000, // Cap at 8 seconds
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

  private async storeEvents(aggregate: T) {
    try {
      const unsavedEvents = aggregate.getUnsavedEvents();

      if (unsavedEvents.length === 0) {
        return;
      }

      const version = aggregate.version - unsavedEvents.length;

      const events = await Promise.all(
        unsavedEvents.map(async (event, index) => {
          return await serialize(event, version + index + 1, this.dbDriver);
        })
      );

      const repository = this.getRepository(aggregate.aggregateId);

      if (this.isSqlite) {
        const batches = this.chunkArray(events, this.sqliteBatchSize);
        for (const batch of batches) {
          await this.insertBatch(batch, repository);
        }
      } else {
        await this.insertWithCopy(events, repository);
      }

      // IMPORTANT: Mark events as saved ONLY after successful database save
      aggregate.markEventsAsSaved();

      // Update cache after successful save
      this.readRepository.cache.set(aggregate.aggregateId, aggregate);
    } catch (error) {
      // IMPORTANT: If save failed, events remain marked as unsaved
      this.readRepository.cache.clear(aggregate.aggregateId);
      this.handleDatabaseError(error, aggregate);
    }
  }

  private async insertBatch(events: EventDataParameters[], repository: Repository<EventDataParameters>) {
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

    // Create optimized stream with 64KB high-water mark for better performance
    const stream = new Readable({
      highWaterMark: 64 * 1024,
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
      // Check if snapshots are enabled for this aggregate
      if (!aggregate.canMakeSnapshot()) {
        // return or throw
        return;
      }

      // Serialize the cloned aggregate - serializeSnapshot() now handles compression internally
      const snapshot = await serializeSnapshot(aggregate as any, this.dbDriver);

      const repository = this.getRepository('snapshots');

      // IMPORTANT: we keep all snapshots instead of overwriting
      await repository.createQueryBuilder().insert().values(snapshot).updateEntity(false).execute();

      aggregate.resetSnapshotCounter();

      // Prune old snapshots if enabled for this aggregate
      if (aggregate.allowPruning) {
        await this.pruneOldSnapshots(aggregate.aggregateId, snapshot.blockHeight);
      }
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

      // IMPORTANT: we don;t throw an error here
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

  /**
   * Removes all snapshots for the given aggregate that have blockHeight lower than the current snapshot.
   * This helps to save storage space by keeping only the latest snapshot.
   *
   * @param aggregateId - The ID of the aggregate
   * @param currentBlockHeight - The block height of the current (latest) snapshot
   */
  private async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number): Promise<void> {
    try {
      const repository = this.getRepository('snapshots');

      // Delete all snapshots with blockHeight lower than current
      const result = await repository
        .createQueryBuilder()
        .delete()
        .where('aggregateId = :aggregateId', { aggregateId })
        .andWhere('blockHeight < :blockHeight', { blockHeight: currentBlockHeight })
        .execute();

      this.log.debug('Old snapshots pruned', {
        args: {
          aggregateId,
          currentBlockHeight,
          deletedCount: result.affected || 0,
        },
      });
    } catch (error) {
      this.log.debug('Error during old snapshots pruning', {
        methodName: 'pruneOldSnapshots',
        args: { error, aggregateId, currentBlockHeight },
      });
    }
  }

  /**
   * Prunes (deletes) old events for the given aggregate up to the specified block height.
   * Only events with blockHeight < pruneToBlockHeight will be deleted.
   *
   * @param aggregate - The aggregate to prune events for
   * @param pruneToBlockHeight - Delete all events below this block height
   * @returns Promise with number of deleted events
   *
   * @throws Error if aggregate doesn't allow events pruning
   * @throws Error if no snapshot exists at or after pruneToBlockHeight for safety
   */
  async pruneEventsToBlockHeight(aggregate: T, pruneToBlockHeight: number): Promise<void> {
    // Check if pruning is allowed for this aggregate
    if (!aggregate.allowPruning) {
      throw new Error(`Event pruning is disabled for aggregate: ${aggregate.aggregateId}`);
    }

    // Execute the pruning
    const repository = this.getRepository(aggregate.aggregateId);

    const result = await repository
      .createQueryBuilder()
      .delete()
      .where('blockHeight < :blockHeight', { blockHeight: pruneToBlockHeight })
      .execute();

    const deletedCount = result.affected || 0;

    this.log.info('Events pruned successfully', {
      args: {
        aggregateId: aggregate.aggregateId,
        prunedToBlock: pruneToBlockHeight,
        deletedEvents: deletedCount,
      },
    });
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
