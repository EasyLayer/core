import { Injectable } from '@nestjs/common';
import RocksDB from 'rocksdb';
import {
  AbstractBatch,
  AbstractChainedBatch,
  // AbstractGetOptions,
  // AbstractIterator,
  // AbstractIteratorOptions,
  // AbstractLevelDOWN,
  // AbstractOpenOptions,
  // AbstractOptions,
} from 'abstract-leveldown';
import { ConnectionManager } from './connection-manager';
import { SchemasManager } from './schemas-manager';
import { generateModelFromSchema } from './generate-model-from-schema';

export type Bytes = string | Buffer;

@Injectable()
export class Repository {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly schemasManager: SchemasManager
  ) {}

  get connection() {
    return this.connectionManager.getConnection();
  }

  async put(key: Bytes, data: Record<string, any>): Promise<void> {
    const db = this.connectionManager.getConnection();
    return new Promise((resolve, reject) => {
      db.put(key, data, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async del(key: Bytes): Promise<void> {
    const db = this.connectionManager.getConnection();
    return new Promise((resolve, reject) => {
      db.del(key, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  public batch(): AbstractChainedBatch<Bytes, Bytes>;
  public batch(array: AbstractBatch[]): Promise<void>;
  public batch(array: AbstractBatch[], options: RocksDB.BatchOptions): Promise<void>;
  public batch(
    array?: AbstractBatch[],
    options?: RocksDB.BatchOptions
  ): AbstractChainedBatch<RocksDB.Bytes, RocksDB.Bytes> | Promise<void> {
    const db = this.connectionManager.getConnection();
    if (!array) {
      // Return an empty batch if no parameters are passed
      return db.batch();
    }

    // If an array of operations is passed, process them
    return new Promise<void>((resolve, reject) => {
      if (options) {
        db.batch(array, options, (err: any) => {
          if (err) return reject(err);
          resolve();
        });
      } else {
        db.batch(array, (err: any) => {
          if (err) return reject(err);
          resolve();
        });
      }
    });
  }

  async get(key: RocksDB.Bytes): Promise<RocksDB.Bytes | null> {
    const db = this.connectionManager.getConnection();
    return new Promise((resolve, reject) => {
      db.get(key, (err: any, value: any) => {
        if (err) {
          if (err.message && err.message.includes('NotFound')) {
            return resolve(null);
          }
          return reject(err);
        }
        resolve(value.toString());
      });
    });
  }

  // Метод для получения данных с учетом условий и связей
  async find(prefix: string, conditions: Record<string, any>, relations: string[] = []): Promise<any[]> {
    const schema = this.schemasManager.getSchema(prefix);
    if (!schema) {
      throw new Error(`Schema for prefix ${prefix} not found`);
    }

    const db = this.connectionManager.getConnection();
    const results: any[] = [];

    const modelClass = generateModelFromSchema(schema);
    const model = new modelClass();
    model.paths = conditions;
    const prefixKey = model.generateKey();

    const iterator = db.iterator({
      gte: prefixKey,
      lte: `${prefixKey}\xff`,
    });

    return new Promise((resolve, reject) => {
      iterator.each(
        async (err: any, key: string, value: string) => {
          if (err) return reject(err);

          const recordModel = new modelClass();
          recordModel.parseKey(key);
          recordModel.parseValue(JSON.parse(value));

          // Обработка условий
          let conditionsMet = true;
          for (const [conditionKey, conditionValue] of Object.entries(conditions)) {
            if (recordModel.paths[conditionKey] !== conditionValue) {
              conditionsMet = false; // пропускаем, если условие не выполнено
              break;
            }
          }

          if (!conditionsMet) {
            return;
          }

          // Обработка связей
          const relationsToReturn: Record<string, any> = {}; // Создаем пустой объект для связей
          for (const relationName of relations) {
            const relation = schema.relations[relationName];
            if (relation) {
              const joinPath = relation.join_paths[0];

              const relatedCondition = {
                [joinPath.referencedPathName]: recordModel.paths[joinPath.name],
              };

              // Переиспользуем метод `this.find` для поиска связанных моделей
              relationsToReturn[relationName] = await this.find(relation.target, relatedCondition);
            }
          }

          if (Object.keys(relationsToReturn).length > 0) {
            recordModel.relations = relationsToReturn; // Присваиваем объект связей в модель
          }

          results.push(recordModel);
        },
        (err: any) => {
          if (err) return reject(err);
          resolve(results);
        }
      );
    });
  }

  async count(prefix: string): Promise<number> {
    const db = this.connectionManager.getConnection();
    return new Promise<number>((resolve, reject) => {
      let count = 0;
      const iterator = db.iterator({
        gte: prefix,
        lte: `${prefix}\xFF`, // Range to iterate over
      });

      function next() {
        iterator.next((err: any, key: any, value: any) => {
          if (err) {
            return reject(err);
          }
          if (key === undefined && value === undefined) {
            // End iteration, return quantity
            return resolve(count);
          }

          // Increment the counter for each entry found
          count += 1;
          next();
        });
      }

      next();
    });
  }
}
