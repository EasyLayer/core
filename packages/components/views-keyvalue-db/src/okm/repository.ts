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
export type DataFactory<S extends EntitySchema> = (
  currentData: S['data'] | null
) => Partial<S['data']> | S['data'] | null;

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
   * @method update
   * @description
   * Updates both paths and data for records matching the provided paths.
   * @param paths Paths that identify the records to update.
   * @param updates Object containing paths to update and/or data to update.
   */
  public async update(
    paths: Record<string, string | PathFactory<S>>,
    updates: {
      pathToUpdate?: Record<string, string>;
      dataToUpdate?: Partial<S['data']> | S['data'] | null;
    }
  ): Promise<void> {
    if (!this.transactionsRunner || !this.transactionsRunner.isTransactionActive()) {
      throw new Error('update must be called within an active transaction');
    }

    const { pathToUpdate, dataToUpdate } = updates;

    const resolvedPaths = await this.resolvePaths(paths);
    const pathCombinations = this.generatePathCombinations(resolvedPaths);

    const batchOps: AbstractBatch[] = [];

    for (const combination of pathCombinations) {
      const oldValidKey = this.schema.toFullKeyString(combination);
      const existingRecord = await this.get(combination);

      // Update paths if provided
      let newKeyPaths = { ...combination };
      if (pathToUpdate) {
        newKeyPaths = { ...newKeyPaths, ...pathToUpdate };
      }

      const newValidKey = this.schema.toFullKeyString(newKeyPaths);

      // Initialize updatedData with existing data or null
      let updatedData: S['data'] | null = existingRecord?.data ?? null;

      if (dataToUpdate !== undefined) {
        if (dataToUpdate === null || typeof dataToUpdate !== 'object') {
          // For null or primitive types, validate and replace all data
          this.schema.validateData(dataToUpdate);
          updatedData = dataToUpdate as S['data'] | null;
        } else {
          // dataToUpdate is an object
          this.schema.validateData(dataToUpdate);
          if (updatedData && typeof updatedData === 'object') {
            // Merge existing data with updates
            updatedData = { ...updatedData, ...dataToUpdate };
          } else {
            // If existing data is not an object, replace entirely
            updatedData = dataToUpdate as S['data'];
          }
        }
      }

      // Add operations to batch
      batchOps.push({ type: 'del', key: oldValidKey });
      batchOps.push({ type: 'put', key: newValidKey, value: this.serialize(updatedData) });
    }

    this.transactionsRunner.addOperations(batchOps);
  }

  /**
   * @method updateByPartial
   * @description
   * Updates records by partial key. Allows updating both paths and data.
   * @param paths Partial paths to identify records.
   * @param updates Object containing paths to update and/or data to update.
   */
  public async updateByPartial(
    paths: Record<string, string | string[] | PathFactory<S>>,
    updates: {
      pathToUpdate?: Record<string, string>;
      dataToUpdate?: Partial<S['data']> | S['data'] | DataFactory<S> | null;
    }
  ): Promise<void> {
    if (!this.transactionsRunner || !this.transactionsRunner.isTransactionActive()) {
      throw new Error('updateByPartial must be called within an active transaction');
    }

    const { pathToUpdate, dataToUpdate } = updates;

    const resolvedPaths = await this.resolvePaths(paths);
    const pathCombinations = this.generatePathCombinations(resolvedPaths);

    const batchOps: AbstractBatch[] = [];

    for (const combination of pathCombinations) {
      const validKey = this.schema.toFullKeyString(combination);
      const existingRecord = await this.get(combination);

      // Update paths if provided
      let newKeyPaths = { ...combination };
      if (pathToUpdate) {
        newKeyPaths = { ...newKeyPaths, ...pathToUpdate };
      }

      const newValidKey = this.schema.toFullKeyString(newKeyPaths);

      // Initialize updatedData with existing data or null
      let updatedData: S['data'] | null = existingRecord?.data ?? null;

      if (dataToUpdate !== undefined) {
        // If dataToUpdate is null or a primitive type
        if (dataToUpdate === null || (typeof dataToUpdate !== 'object' && typeof dataToUpdate !== 'function')) {
          // Validate and replace all data
          this.schema.validateData(dataToUpdate);
          updatedData = dataToUpdate as S['data'] | null;
        } else if (typeof dataToUpdate === 'function') {
          // dataToUpdate is a factory function
          // Call it with current data
          const factoryResult = (dataToUpdate as DataFactory<S>)(existingRecord?.data ?? null);
          if (factoryResult !== null && typeof factoryResult === 'object') {
            // Validate factoryResult against schema
            this.schema.validateData(factoryResult);
            if (updatedData && typeof updatedData === 'object') {
              // Merge factory result with existing data
              updatedData = { ...updatedData, ...factoryResult };
            } else {
              // If existing data is not an object, replace entirely
              updatedData = factoryResult as S['data'];
            }
          } else {
            // If factoryResult is null or not an object, set data to factoryResult
            updatedData = factoryResult as S['data'] | null;
          }
        } else {
          // dataToUpdate is an object
          // Validate dataToUpdate against schema
          this.schema.validateData(dataToUpdate);
          if (updatedData && typeof updatedData === 'object') {
            // Merge existing data with updates
            updatedData = { ...updatedData, ...dataToUpdate };
          } else {
            // If existing data is not an object, replace entirely
            updatedData = dataToUpdate as S['data'];
          }
        }
      }

      // Add operations to batch
      if (validKey !== newValidKey) {
        // If the key has changed, delete the old key and put the new key with updated data
        batchOps.push({ type: 'del', key: validKey });
        batchOps.push({ type: 'put', key: newValidKey, value: this.serialize(updatedData) });
      } else if (dataToUpdate !== undefined) {
        // If the key hasn't changed but data has, update the data
        batchOps.push({ type: 'put', key: newValidKey, value: this.serialize(updatedData) });
      }
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
