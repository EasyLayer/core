import { promisify } from 'node:util';
import { AbstractBatch } from 'abstract-leveldown';
import { ConnectionManager } from './connection-manager';
import { TransactionsRunner } from './transactions-runner';
import { EntitySchema } from './schema';

export interface SimpleModel<T> {
  key: string;
  data: T | null;
}

export type PathFactory<S extends EntitySchema> = (repository: Repository<S>) => Promise<string | string[]>;

/**
 * @class Repository
 * Provides CRUD operations and partial operations using a schema for key generation.
 * Delegates key generation/validation logic to EntitySchema.
 */
export class Repository<S extends EntitySchema> {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly schema: S,
    private readonly transactionsRunner?: TransactionsRunner
  ) {}

  get connection() {
    return this.connectionManager.getConnection();
  }

  private serialize(value: any): string {
    return JSON.stringify(value);
  }

  private deserialize(value: string): any {
    return JSON.parse(value);
  }

  /**
   * @method put
   * @description
   * Inserts or updates a record by a full key. Validates and completes the full key via schema.
   * @param key Full key as object or string.
   * @param data Data to store.
   */
  public async put(key: Record<string, string> | string, data?: S['data']): Promise<void> {
    try {
      const validKey = this.schema.toFullKeyString(key);
      const serializedData = data !== undefined ? this.serialize(data) : JSON.stringify(null);

      const operation: AbstractBatch = { type: 'put', key: validKey, value: serializedData };

      if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
        this.transactionsRunner.addOperation(operation);
      } else {
        const putAsync = promisify(this.connection.put).bind(this.connection);
        await putAsync(validKey, serializedData);
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * @method del
   * @description
   * Deletes a record by a full key.
   * @param key Full key as object or string.
   */
  public async del(key: Record<string, string> | string): Promise<void> {
    try {
      const validKey = this.schema.toFullKeyString(key);
      const operation: AbstractBatch = { type: 'del', key: validKey };

      if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
        this.transactionsRunner.addOperation(operation);
      } else {
        const delAsync = promisify(this.connection.del).bind(this.connection);
        await delAsync(validKey);
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * @method get
   * @description
   * Retrieves a record by a full key.
   * @param key Full key as object or string.
   */
  public async get(key: Record<string, string> | string): Promise<SimpleModel<S['data']> | null> {
    try {
      const validKey = this.schema.toFullKeyString(key);
      const getAsync = promisify(this.connection.get).bind(this.connection);

      let value = await getAsync(validKey);
      if (Buffer.isBuffer(value)) {
        value = value.toString('utf-8');
      } else if (typeof value !== 'string') {
        throw new Error(`Unexpected value type for key ${validKey}: ${typeof value}`);
      }

      const data = this.deserialize(value);

      return { key: validKey, data };
    } catch (error: any) {
      if (error.notFound || (error.message && error.message.includes('NotFound'))) {
        return null;
      }
      throw error;
    }
  }

  /**
   * @method exists
   * @description
   * Checks if a record exists for a given full key.
   * @param key Full key as object or string.
   */
  public async exists(key: Record<string, string> | string): Promise<boolean> {
    const result = await this.get(key);
    return result !== null;
  }

  /**
   * @method getByPartial
   * @description
   * Retrieves records by a partial key. Supports string or object partial key.
   * Uses schema to convert partial key to a partial key string.
   * Minimal validation, just scan range and optionally filter by suffix.
   * @param prefix Partial key (string or object)
   * @param suffix Optional suffix
   */
  public async getByPartial(
    prefix?: string | Record<string, string>,
    suffix?: string
  ): Promise<SimpleModel<S['data']>[]> {
    const results: SimpleModel<S['data']>[] = [];
    let iterator: any;

    try {
      const partialKeyStr = this.schema.toPartialKeyString(prefix);
      const gteKey = partialKeyStr;
      const lteKey = `${partialKeyStr}\xFF`;

      iterator = this.connection.iterator({
        gte: gteKey,
        lte: lteKey,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      // Instead of promisify(...) we create a custom promise wrapper:
      const nextAsync = (): Promise<[string | undefined, string | undefined]> => {
        return new Promise((resolve, reject) => {
          iterator.next((err: any, key?: string, value?: string) => {
            if (err) return reject(err);
            resolve([key, value]);
          });
        });
      };

      while (true) {
        const [key, value] = await nextAsync();
        if (key === undefined) break;

        let matches = true;
        if (suffix) {
          matches = this.schema.matchesSuffix(key, suffix);
        }

        if (matches) {
          let valueStr: string;
          if (Buffer.isBuffer(value)) {
            valueStr = value.toString('utf-8');
          } else if (typeof value === 'string') {
            valueStr = value;
          } else {
            throw new Error(`Unexpected value type for key ${key}: ${typeof value}`);
          }

          const data = this.deserialize(valueStr);
          results.push({ key, data });
        }
      }

      return results;
    } catch (error) {
      throw error;
    } finally {
      if (iterator) {
        const endAsync = (): Promise<void> => {
          return new Promise((resolve, reject) => {
            iterator.end((err: any) => {
              if (err) return reject(err);
              resolve();
            });
          });
        };
        await endAsync();
      }
    }
  }

  /**
   * @method deleteByPartial
   * @description
   * Deletes records by partial key. Similar to getByPartial but deletes each matching key.
   */
  public async deleteByPartial(prefix?: string | Record<string, string>, suffix?: string): Promise<void> {
    let iterator: any;

    try {
      const partialKeyStr = this.schema.toPartialKeyString(prefix);
      const gteKey = partialKeyStr;
      const lteKey = `${partialKeyStr}\xFF`;

      iterator = this.connection.iterator({
        gte: gteKey,
        lte: lteKey,
        keyAsBuffer: false,
        valueAsBuffer: false,
        values: false,
      });

      const nextAsync = promisify(iterator.next).bind(iterator);

      while (true) {
        const key = await nextAsync();
        if (key === undefined) break;

        let matches = true;
        if (suffix) {
          matches = this.schema.matchesSuffix(key, suffix);
        }

        if (matches) {
          const operation: AbstractBatch = { type: 'del', key };

          if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
            this.transactionsRunner.addOperation(operation);
          } else {
            const delAsync = promisify(this.connection.del).bind(this.connection);
            await delAsync(key);
          }
        }
      }
    } catch (error) {
      throw error;
    } finally {
      if (iterator) {
        const endAsync = promisify(iterator.end).bind(iterator);
        await endAsync();
      }
    }
  }

  /**
   * @method countByPartial
   * @description
   * Counts records by partial key. Similar to getByPartial but just counts.
   */
  public async countByPartial(prefix?: string | Record<string, string>, suffix?: string): Promise<number> {
    let count = 0;
    let iterator: any;

    try {
      const partialKeyStr = this.schema.toPartialKeyString(prefix);
      const gteKey = partialKeyStr;
      const lteKey = `${partialKeyStr}\xFF`;

      iterator = this.connection.iterator({
        gte: gteKey,
        lte: lteKey,
        keyAsBuffer: false,
        valueAsBuffer: false,
        values: false,
      });

      const nextAsync = promisify(iterator.next).bind(iterator);

      while (true) {
        const key = await nextAsync();
        if (key === undefined) break;

        let matches = true;
        if (suffix) {
          matches = this.schema.matchesSuffix(key, suffix);
        }

        if (matches) count += 1;
      }

      return count;
    } catch (error) {
      throw error;
    } finally {
      if (iterator) {
        const endAsync = promisify(iterator.end).bind(iterator);
        await endAsync();
      }
    }
  }

  /**
   * @method updateData
   * @description
   * Updates data for a full key by simply calling put with validated full key.
   * @param key Full key as object or string.
   * @param data New data.
   */
  public async updateData(key: Record<string, string> | string, data: S['data']): Promise<void> {
    await this.put(key, data);
  }

  /**
   * @method updateDataByPartial
   * @description
   * Updates data for all records matching a partial key inside a transaction.
   */
  public async updateDataByPartial(
    data: Partial<S['data']>,
    prefix?: string | Record<string, string>,
    suffix?: string
  ): Promise<void> {
    if (!this.transactionsRunner || !this.transactionsRunner.isTransactionActive()) {
      throw new Error('updateDataByPartial must be called within an active transaction');
    }

    const records = await this.getByPartial(prefix, suffix);
    if (records.length === 0) return;

    const batchOps: AbstractBatch[] = [];

    for (const record of records) {
      const keyString = this.schema.toFullKeyString(record.key);

      let updatedData: S['data'];
      if (typeof record.data === 'object' && record.data !== null) {
        updatedData = { ...record.data, ...data } as S['data'];
      } else {
        updatedData = data as S['data'];
      }

      const operation: AbstractBatch = { type: 'put', key: keyString, value: this.serialize(updatedData) };
      batchOps.push(operation);
    }

    this.transactionsRunner.addOperations(batchOps);
  }

  /**
   * @method updateKey
   * @description
   * Updates a key by resolving paths (including factories), generating all combinations, and updating keys.
   * Works only inside a transaction.
   * @param paths Paths that may contain factories returning multiple values.
   * @param pathToUpdate Key parts to update.
   */
  public async updateKey(
    paths: Record<string, string | PathFactory<S>>,
    pathToUpdate: Record<string, string>
  ): Promise<void> {
    if (!this.transactionsRunner || !this.transactionsRunner.isTransactionActive()) {
      throw new Error('updateKey must be called within an active transaction');
    }

    const resolvedPaths = await this.resolvePaths(paths);
    const pathCombinations = this.generatePathCombinations(resolvedPaths);

    const batchOps: AbstractBatch[] = [];

    for (const combination of pathCombinations) {
      const oldValidKey = this.schema.toFullKeyString(combination);
      const existingRecord = await this.get(combination);

      const newKeyPaths = { ...combination, ...pathToUpdate };
      const newValidKey = this.schema.toFullKeyString(newKeyPaths);

      batchOps.push({ type: 'del', key: oldValidKey });
      batchOps.push({ type: 'put', key: newValidKey, value: this.serialize(existingRecord?.data ?? null) });
    }

    this.transactionsRunner.addOperations(batchOps);
  }

  /**
   * @method updateKeyByPartial
   * @description
   * Similar to updateKey but works with partial keys. Generates combinations, gets records, updates keys inside a transaction.
   */
  public async updateKeyByPartial(
    paths: Record<string, string | string[] | PathFactory<S>>,
    pathToUpdate: Record<string, string>
  ): Promise<void> {
    if (!this.transactionsRunner || !this.transactionsRunner.isTransactionActive()) {
      throw new Error('updateKeyByPartial must be called within an active transaction');
    }

    const resolvedPaths = await this.resolvePaths(paths);
    const pathCombinations = this.generatePathCombinations(resolvedPaths);

    const batchOps: AbstractBatch[] = [];

    for (const combination of pathCombinations) {
      const validKey = this.schema.toFullKeyString(combination);
      const existingRecord = await this.get(combination);

      const newKeyPaths = { ...combination, ...pathToUpdate };
      const newValidKey = this.schema.toFullKeyString(newKeyPaths);

      batchOps.push({ type: 'del', key: validKey });
      batchOps.push({ type: 'put', key: newValidKey, value: this.serialize(existingRecord?.data ?? null) });
    }

    this.transactionsRunner.addOperations(batchOps);
  }

  /**
   * @method resolvePaths
   * @description
   * Resolves factories in paths to their string or string[] values.
   * @param paths Paths that may contain factories.
   */
  private async resolvePaths(
    paths: Record<string, string | string[] | PathFactory<S>>
  ): Promise<Record<string, string | string[]>> {
    const resolvedPaths: Record<string, string | string[]> = {};

    for (const [key, value] of Object.entries(paths)) {
      if (typeof value === 'function') {
        const result = await value(this);
        resolvedPaths[key] = result;
      } else {
        resolvedPaths[key] = value;
      }
    }

    return resolvedPaths;
  }

  /**
   * @method generatePathCombinations
   * @description
   * Generates all combinations (cartesian product) from the given paths (some may be arrays).
   */
  private generatePathCombinations(paths: Record<string, string | string[]>): Array<Record<string, string>> {
    const keys = Object.keys(paths);
    const values = Object.values(paths).map((v) => (Array.isArray(v) ? v : [v]));

    const combos = this.cartesianProduct(values);
    return combos.map((combination) => {
      const pathObj: Record<string, string> = {};
      combination.forEach((value: any, index: number) => {
        pathObj[keys[index]] = value;
      });
      return pathObj;
    });
  }

  /**
   * @method cartesianProduct
   * @description
   * Computes cartesian product of arrays.
   * @param arrays Array of arrays.
   */
  private cartesianProduct(arrays: any[]): any[] {
    return arrays.reduce((a, b) => a.flatMap((d: any) => b.map((e: any) => [...d, e])), [[]]);
  }
}
