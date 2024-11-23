import { promisify } from 'node:util';
import { AbstractBatch } from 'abstract-leveldown';
import { ConnectionManager } from './connection-manager';
import { TransactionsRunner } from './transactions-runner';
import { EntitySchema } from './schema';

export interface SimpleModel<T> {
  key: Record<string, string>; // Parsed key parts
  data: T; // Data value
}

export class Repository<S extends EntitySchema> {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly schema: EntitySchema,
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
   * Method to save data
   * @param key Values for generating the key (object or string)
   * @param data Data to be saved
   * @returns Promise<void>
   */
  public async put(key: Record<string, string> | string, data: S['data']): Promise<void> {
    try {
      // Generate the full key using the schema (adds prefix and validates the key)
      const validKey = this.schema.generateKey(key);

      const serializedData = this.serialize(data);

      const operation: AbstractBatch = { type: 'put', key: validKey, value: serializedData };

      if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
        // Add operation to the transaction
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
   * Method to delete data
   * @param key Values for generating the key (object or string)
   * @returns Promise<void>
   */
  public async del(key: Record<string, string> | string): Promise<void> {
    try {
      // Generate the full key using the schema
      const validKey = this.schema.generateKey(key);

      const operation: AbstractBatch = { type: 'del', key: validKey };

      if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
        // Add operation to the transaction
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
   * Method to retrieve data by key
   * @param key Values for generating the key (object or string)
   * @returns Promise<SimpleModel | null>
   */
  public async get(key: Record<string, string> | string): Promise<SimpleModel<S['data']> | null> {
    try {
      // Generate the full key using the schema
      const validKey = this.schema.generateKey(key);

      const getAsync = promisify(this.connection.get).bind(this.connection);

      let value = await getAsync(validKey);

      // Ensure value is a string before deserialization
      if (Buffer.isBuffer(value)) {
        value = value.toString('utf-8');
      } else if (typeof value !== 'string') {
        throw new Error(`Unexpected value type for key ${validKey}: ${typeof value}`);
      }

      // Deserialize the JSON string to object
      const data = this.deserialize(value);

      // Parse the key to get dynamic path values
      const keyParts = this.schema.parseKey(validKey);

      return { key: keyParts, data };
    } catch (error: any) {
      // Handle not found error
      if (error.notFound || (error.message && error.message.includes('NotFound'))) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Method to check if data exists by key
   * @param key Values for generating the key (object or string)
   * @returns Promise<boolean>
   */
  public async exists(key: Record<string, string> | string): Promise<boolean> {
    try {
      const result = await this.get(key);
      return result !== null;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Method to retrieve data by partial key
   * @returns Promise<SimpleModel[]>
   */
  public async getByPartial(prefix?: string, suffix?: string): Promise<SimpleModel<S['data']>[]> {
    const results: SimpleModel<S['data']>[] = [];
    let iterator: any;

    try {
      // Determine the prefix key
      const prefixKey = prefix ? this.schema.generatePrefixFromString(prefix) : this.schema.prefix;

      // Create iterator starting from prefixKey
      iterator = this.connection.iterator({
        gte: prefixKey,
        lte: `${prefixKey}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      const nextAsync = (): Promise<[string | undefined, string | undefined]> => {
        return new Promise((resolve, reject) => {
          iterator.next((err: any, key: string, value: string) => {
            if (err) {
              return reject(err);
            }
            resolve([key, value]);
          });
        });
      };

      while (true) {
        const [key, value] = await nextAsync();
        if (key === undefined) {
          // End of iteration
          break;
        }

        let matches = true;

        if (suffix) {
          // Use the schema method to check if the key matches the suffix
          matches = this.schema.matchesSuffix(key, suffix);
        }

        if (matches) {
          // Ensure value is a string before deserialization
          let valueStr: string;
          if (Buffer.isBuffer(value)) {
            valueStr = value.toString('utf-8');
          } else if (typeof value === 'string') {
            valueStr = value;
          } else {
            throw new Error(`Unexpected value type for key ${key}: ${typeof value}`);
          }

          const data = this.deserialize(valueStr);

          // Parse the key to get dynamic path values
          const keyParts = this.schema.parseKey(key);

          results.push({ key: keyParts, data });
        }
      }

      return results;
    } catch (error) {
      throw error;
    } finally {
      if (iterator) {
        // Ensure the iterator is closed
        const endAsync = promisify(iterator.end).bind(iterator);
        try {
          await endAsync();
        } catch (err: any) {
          throw new Error(`Error closing iterator in getByPartial: ${err}`);
        }
      }
    }
  }

  /**
   * Method to delete data by partial key
   * @returns Promise<void>
   */
  public async deleteByPartial(prefix?: string, suffix?: string): Promise<void> {
    let iterator: any;

    try {
      // Determine the prefix key
      const prefixKey = prefix ? this.schema.generatePrefixFromString(prefix) : this.schema.prefix;

      // Create iterator starting from prefixKey
      iterator = this.connection.iterator({
        gte: prefixKey,
        lte: `${prefixKey}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      const nextAsync = (): Promise<string | undefined> => {
        return new Promise((resolve, reject) => {
          iterator.next((err: any, key: string) => {
            if (err) {
              return reject(err);
            }
            resolve(key);
          });
        });
      };

      while (true) {
        const key = await nextAsync();
        if (key === undefined) {
          // End of iteration
          break;
        }

        let matches = true;

        if (suffix) {
          // Use the schema method to check if the key matches the suffix
          matches = this.schema.matchesSuffix(key, suffix);
        }

        if (matches) {
          const operation: AbstractBatch = { type: 'del', key };

          if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
            // Add operation to the transaction
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
        // Ensure the iterator is closed
        const endAsync = promisify(iterator.end).bind(iterator);
        try {
          await endAsync();
        } catch (err: any) {
          throw new Error(`Error closing iterator in deleteByPartial: ${err}`);
        }
      }
    }
  }

  /**
   * Method to count the number of records by partial key
   * @returns Promise<number>
   */
  public async countByPartial(prefix?: string, suffix?: string): Promise<number> {
    let count = 0;
    let iterator: any;

    try {
      // Determine the prefix key
      const prefixKey = prefix ? this.schema.generatePrefixFromString(prefix) : this.schema.prefix;

      // Create iterator starting from prefixKey
      iterator = this.connection.iterator({
        gte: prefixKey,
        lte: `${prefixKey}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      const nextAsync = (): Promise<string | undefined> => {
        return new Promise((resolve, reject) => {
          iterator.next((err: any, key: string) => {
            if (err) {
              return reject(err);
            }
            resolve(key);
          });
        });
      };

      while (true) {
        const key = await nextAsync();
        if (key === undefined) {
          // End of iteration
          break;
        }

        let matches = true;

        if (suffix) {
          // Use the schema method to check if the key matches the suffix
          matches = this.schema.matchesSuffix(key, suffix);
        }

        if (matches) {
          count += 1;
        }
      }

      return count;
    } catch (error) {
      throw error;
    } finally {
      if (iterator) {
        // Ensure the iterator is closed
        const endAsync = promisify(iterator.end).bind(iterator);
        try {
          await endAsync();
        } catch (err: any) {
          throw new Error(`Error closing iterator in countByPartial: ${err}`);
        }
      }
    }
  }
}
