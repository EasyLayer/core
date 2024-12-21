import { DataSource, QueryRunner, RdbmsSchemaBuilder } from '@easylayer/components/views-rdbms-db';
import { AggregateRoot } from '@easylayer/components/cqrs';
import { AppLogger } from '@easylayer/components/logger';
import { BitcoinSchemaUpMigrationFinishedEvent } from '@easylayer/common/domain-cqrs-components/bitcoin';

export class Schema extends AggregateRoot {
  // IMPORTANT: There must be only one Schema Aggregate in the module,
  // so we immediately give it aggregateId by which we can find it.
  public aggregateId: string = 'schema';
  public upQueries: any[] = [];
  public downQueries: any[] = [];

  // To ensure data consistency between the written and read models,
  // we check what needs to be updated in the read schema and publish events while maintaining the state
  // in the read database. Further, the EventHandler will be responsible for updating the schema itself.
  public async init({
    requestId,
    dataSource,
    logger,
  }: {
    requestId: string;
    dataSource: DataSource;
    logger: AppLogger;
  }) {
    if (!dataSource.isInitialized) {
      throw new Error('Datasource is still not initialized');
    }

    const sqlQueries = await getSQLFromEntitySchema(dataSource);

    const { upQueries, downQueries } = sqlQueries;

    if (upQueries.length === 0 && downQueries.length === 0) {
      // In cases where there is nothing to update, just exit
      logger.info('Scheme is already up to date', {}, this.constructor.name);
      return;
    }

    logger.info(
      'Scheme needs to be updated',
      { upQueriesLength: upQueries.length, downQueriesLength: downQueries.length },
      this.constructor.name
    );

    await this.apply(
      new BitcoinSchemaUpMigrationFinishedEvent({
        aggregateId: this.aggregateId,
        requestId,
        upQueries: sqlQueries.upQueries,
        downQueries: sqlQueries.downQueries,
      })
    );
  }

  public async up({}) {
    throw new Error('method up is not implemented yes');
  }

  public async down({}) {
    throw new Error('method up is not implemented yes');
  }

  private onBitcoinSchemaUpMigrationFinishedEvent({ payload }: BitcoinSchemaUpMigrationFinishedEvent) {
    const { upQueries, downQueries } = payload;

    this.upQueries = [...upQueries];
    this.downQueries = [...downQueries];
  }
}

async function getSQLFromEntitySchema(dataSource: DataSource): Promise<{ upQueries: any[]; downQueries: any[] }> {
  const queryRunner: QueryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();

    // Using SchemaBuilder to Generate SQL
    const schemaBuilder = new RdbmsSchemaBuilder(dataSource);

    return await schemaBuilder.log();
  } catch (error) {
    throw error;
  } finally {
    await queryRunner.release();
  }
}
