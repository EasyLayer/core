import { DataSource, QueryRunner } from 'typeorm';
import { RdbmsSchemaBuilder } from 'typeorm/schema-builder/RdbmsSchemaBuilder';

export async function getSQLFromEntitySchema(
  dataSource: DataSource
): Promise<{ upQueries: any[]; downQueries: any[] }> {
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
