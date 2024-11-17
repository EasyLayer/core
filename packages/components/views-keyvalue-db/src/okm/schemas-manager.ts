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

  getRepository<T>(prefix: string, transactionsRunner?: TransactionsRunner): Repository<T> {
    const schema = this.getSchemaByPrefix(prefix);
    if (!schema) {
      throw new Error(`Schema with prefix ${prefix} not found`);
    }

    return new Repository<T>(this.connectionManager, schema, transactionsRunner);
  }
}
