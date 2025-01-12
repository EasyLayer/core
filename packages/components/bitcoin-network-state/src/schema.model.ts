import { DataSource, QueryRunner, getSQLFromEntitySchema } from '@easylayer/components/views-rdbms-db';
import { AggregateRoot } from '@easylayer/components/cqrs';
import { AppLogger } from '@easylayer/components/logger';
import {
  BitcoinSchemaUpdatedEvent,
  BitcoinSchemaSynchronisedEvent,
} from '@easylayer/common/domain-cqrs-components/bitcoin';

export class Schema extends AggregateRoot {
  // IMPORTANT: There must be only one Schema Aggregate in the module,
  // so we immediately give it aggregateId by which we can find it.
  public aggregateId: string = 'schema';
  public upQueries: any[] = [];
  public downQueries: any[] = [];

  public async sync({
    requestId,
    dataSource,
    queryRunner,
    logger,
    isUnlogged,
  }: {
    requestId: string;
    dataSource: DataSource;
    queryRunner: QueryRunner;
    logger: AppLogger;
    isUnlogged?: boolean;
  }) {
    const sqlQueries = await getSQLFromEntitySchema(dataSource);

    const { upQueries, downQueries } = sqlQueries;

    if (upQueries.length === 0) {
      // This means that there are no more changes and we publish an event that everything is synced
      logger.debug('Schema is synchronised', {}, this.constructor.name);

      return await this.apply(
        new BitcoinSchemaSynchronisedEvent({
          aggregateId: this.aggregateId,
          requestId,
        })
      );
    }

    logger.debug('Schema needs to be updated', { upQueriesLength: upQueries.length }, this.constructor.name);

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

    return await this.update({
      requestId,
      upQueries: modifiedUpQueries,
      downQueries,
      queryRunner,
      logger,
    });
  }

  // IMPORTANT: This command does not look at the database or migrations
  // it only updates what it is told.
  public async update({
    requestId,
    upQueries,
    downQueries,
    queryRunner,
    logger,
  }: {
    requestId: string;
    upQueries: any[];
    downQueries: any[];
    queryRunner: QueryRunner;
    logger: AppLogger;
  }) {
    await queryRunner.connect();
    await queryRunner.startTransaction();

    logger.debug('Views Shema updating...', { upQueries }, this.constructor.name);

    // Executing modified SQL queries
    for (const queryObj of upQueries) {
      await queryRunner.query(queryObj.query);
    }

    await queryRunner.commitTransaction();

    await this.apply(
      new BitcoinSchemaUpdatedEvent({
        aggregateId: this.aggregateId,
        requestId,
        upQueries,
        downQueries,
      })
    );
  }

  private onBitcoinSchemaSynchronisedEvent({ payload }: BitcoinSchemaSynchronisedEvent) {
    const { aggregateId } = payload;
    this.aggregateId = aggregateId;
  }

  private onBitcoinSchemaUpdatedEvent({ payload }: BitcoinSchemaUpdatedEvent) {
    const { aggregateId, upQueries, downQueries } = payload;
    this.aggregateId = aggregateId;
    this.upQueries = upQueries;
    this.downQueries = downQueries;
  }
}
