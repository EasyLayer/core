import { Injectable } from '@nestjs/common';
import { EntitySchema } from './schema';
import { Repository } from './repository';
import { ConnectionManager } from './connection-manager';
import { TransactionsRunner } from './transactions-runner';

export type EntityClassOrSchema = { new (): EntitySchema } | EntitySchema;

@Injectable()
export class EntitiesManager {
  private _entities: Map<string, EntitySchema>;

  constructor(
    entities: EntityClassOrSchema[],
    private readonly connectionManager: ConnectionManager
  ) {
    this._entities = new Map();
    entities.forEach((entity) => {
      const schema = typeof entity === 'function' ? new (entity as { new (): EntitySchema })() : entity;
      if (!schema.prefix) {
        throw new Error('Each EntitySchema must have a prefix property.');
      }
      this._entities.set(schema.prefix, schema);
    });
  }

  get entities() {
    return this._entities;
  }

  public getSchemaByPrefix(prefix: string): EntitySchema | undefined {
    return this._entities.get(prefix);
  }

  public getRepository<T extends EntitySchema>(prefix: string, transactionsRunner?: TransactionsRunner): Repository<T> {
    const schema = this.getSchemaByPrefix(prefix);
    if (!schema) {
      throw new Error(`Schema with prefix "${prefix}" not found`);
    }

    return new Repository<T>(this.connectionManager, schema as T, transactionsRunner);
  }
}
