import { Injectable } from '@nestjs/common';
import { EntitySchema } from './schema';
import { Repository } from './repository';
import { ConnectionManager } from './connection-manager';
import { TransactionsRunner } from './transactions-runner';

@Injectable()
export class SchemasManager {
  private _schemas: Map<string, EntitySchema>;

  constructor(
    schemas: EntitySchema[],
    private readonly connectionManager: ConnectionManager
  ) {
    this._schemas = new Map();
    schemas.forEach((schema) => {
      this._schemas.set(schema.prefix, schema);
    });
  }

  get schemas() {
    return this._schemas;
  }

  getSchemaByPrefix(prefix: string): EntitySchema | undefined {
    return this._schemas.get(prefix);
  }

  /**
   * Type guard to check if a schema is of type T.
   * @param schema The schema to check.
   */
  private isSchemaOfType<T extends EntitySchema>(schema: EntitySchema, type: new () => T): schema is T {
    return schema instanceof type;
  }

  getRepository<T extends EntitySchema>(
    prefix: string,
    type: new () => T,
    transactionsRunner?: TransactionsRunner
  ): Repository<T> {
    const schema = this.getSchemaByPrefix(prefix);
    if (!schema) {
      throw new Error(`Schema with prefix ${prefix} not found`);
    }

    if (!this.isSchemaOfType(schema, type)) {
      throw new Error(`Schema with prefix ${prefix} is not of the expected type`);
    }

    return new Repository<T>(this.connectionManager, schema, transactionsRunner);
  }
}
