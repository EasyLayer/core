import { DataSource, QueryRunner, getSQLFromEntitySchema } from '@easylayer/components/views-rdbms-db';
import { AggregateRoot } from '@easylayer/components/cqrs';
import { AppLogger } from '@easylayer/components/logger';
import {
  BitcoinSchemaUpMigrationStartedEvent,
  BitcoinSchemaUpMigrationFinishedEvent,
  BitcoinSchemaSynchronisedEvent,
} from '@easylayer/common/domain-cqrs-components/bitcoin';

export enum SchemaStatuses {
  SYNCHRONISING = 'synchronising',
  SYNCHRONISED = 'synchronised',
}

export class Schema extends AggregateRoot {
  // IMPORTANT: There must be only one Schema Aggregate in the module,
  // so we immediately give it aggregateId by which we can find it.
  public aggregateId: string = 'schema';
  public status: SchemaStatuses = SchemaStatuses.SYNCHRONISED;
  public upQueries: any[] = [];
  public downQueries: any[] = [];

  public async checkSync({
    requestId,
    dataSource,
    logger,
    isUnlogged,
  }: {
    requestId: string;
    dataSource: DataSource;
    logger: AppLogger;
    isUnlogged?: boolean;
  }) {
    if (this.status !== SchemaStatuses.SYNCHRONISED) {
      throw new Error(`We can only start checking if the previous synchronization is ${SchemaStatuses.SYNCHRONISED}`);
    }

    const sqlQueries = await getSQLFromEntitySchema(dataSource);

    const { upQueries, downQueries } = sqlQueries;

    if (upQueries.length === 0 && downQueries.length === 0) {
      // This means that there are no more changes and we publish an event that everything is synced
      // IMPORTANT: This event is only in this one place.

      logger.info('Schema is synchronised', {}, this.constructor.name);

      return await this.apply(
        new BitcoinSchemaSynchronisedEvent({
          aggregateId: this.aggregateId,
          requestId,
          status: SchemaStatuses.SYNCHRONISED,
        })
      );
    }

    logger.info(
      'Schema needs to be updated',
      { upQueriesLength: upQueries.length, downQueriesLength: downQueries.length },
      this.constructor.name
    );

    let modifiedUpQueries = [...upQueries];

    if (isUnlogged) {
      // Modify queries to add UNLOGGED where necessary
      modifiedUpQueries = modifiedUpQueries.map((queryObj) => {
        if (queryObj.query.startsWith('CREATE TABLE')) {
          const modifiedQuery = queryObj.query.replace('CREATE TABLE', 'CREATE UNLOGGED TABLE');
          return { ...queryObj, query: modifiedQuery };
        }
        return queryObj;
      });
    }

    await this.apply(
      new BitcoinSchemaUpMigrationStartedEvent({
        aggregateId: this.aggregateId,
        requestId,
        upQueries: modifiedUpQueries,
        downQueries: sqlQueries.downQueries,
        status: SchemaStatuses.SYNCHRONISING,
      })
    );
  }

  public async up({
    requestId,
    upQueries,
    dataSource,
    logger,
  }: {
    requestId: string;
    upQueries: any[];
    dataSource: DataSource;
    logger: AppLogger;
  }) {
    if (this.status !== SchemaStatuses.SYNCHRONISING) {
      throw new Error(`We can complete the migration only if the schema status is ${SchemaStatuses.SYNCHRONISING}`);
    }

    // IMPORTANT: This command does not look at the database or migrations
    // it only updates what it is told.

    const viewsQueryRunner: QueryRunner = dataSource.createQueryRunner();

    await viewsQueryRunner.connect();
    await viewsQueryRunner.startTransaction();

    try {
      logger.debug('Views Shema updating...', { upQueries }, this.constructor.name);

      // Executing modified SQL queries
      for (const queryObj of upQueries) {
        await viewsQueryRunner.query(queryObj.query);
      }

      await viewsQueryRunner.commitTransaction();
    } catch (e) {
      await viewsQueryRunner.rollbackTransaction();
      throw e;
    } finally {
      await viewsQueryRunner.release();
    }

    await this.apply(
      new BitcoinSchemaUpMigrationFinishedEvent({
        aggregateId: this.aggregateId,
        requestId,
        status: SchemaStatuses.SYNCHRONISED,
      })
    );
  }

  public async down({}) {
    throw new Error('method up is not implemented yes');
  }

  private onBitcoinSchemaSynchronisedEvent({ payload }: BitcoinSchemaSynchronisedEvent) {
    const { status } = payload;
    this.status = status as SchemaStatuses;
  }

  private onBitcoinSchemaUpMigrationStartedEvent({ payload }: BitcoinSchemaUpMigrationStartedEvent) {
    const { upQueries, downQueries, status } = payload;
    this.upQueries = [...upQueries];
    this.downQueries = [...downQueries];
    this.status = status as SchemaStatuses;
  }

  private onBitcoinSchemaUpMigrationFinishedEvent({ payload }: BitcoinSchemaUpMigrationFinishedEvent) {
    const { status } = payload;
    this.status = status as SchemaStatuses;
  }
}
