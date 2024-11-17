import { Injectable } from '@nestjs/common';
import { EntitySchema } from './schema';
import { Repository } from './repository';
import { ConnectionManager } from './connection-manager';
import { TransactionsRunner } from './transactions-runner';

@Injectable()
export class SchemasManager {
  private schemas: Map<string, EntitySchema>;

  constructor(
    schemas: EntitySchema[],
    private readonly connectionManager: ConnectionManager
  ) {
    this.schemas = new Map();
    schemas.forEach((schema) => {
      this.schemas.set(schema.prefix, schema);
    });
  }

  /**
   * Метод для получения схемы по префиксу
   * @param prefix Префикс схемы
   * @returns Схема сущности или undefined
   */
  getSchemaByPrefix(prefix: string): EntitySchema | undefined {
    return this.schemas.get(prefix);
  }

  /**
   * Получает репозиторий для заданной схемы
   * @param prefix Префикс схемы
   * @param transactionsRunner Опциональный TransactionsRunner для транзакций
   * @returns Репозиторий
   */
  getRepository<T>(prefix: string, transactionsRunner?: TransactionsRunner): Repository<T> {
    const schema = this.getSchemaByPrefix(prefix);
    if (!schema) {
      throw new Error(`Схема с префиксом ${prefix} не найдена`);
    }

    return new Repository<T>(this.connectionManager, schema, transactionsRunner);
  }
}
