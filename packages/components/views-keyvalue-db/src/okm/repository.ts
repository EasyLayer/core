import { AbstractBatch } from 'abstract-leveldown';
import { ConnectionManager } from './connection-manager';
import { TransactionsRunner } from './transactions-runner';
import { EntitySchema } from './schema';

export class Repository<T> {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly schema: EntitySchema,
    private readonly transactionsRunner?: TransactionsRunner
  ) {}

  get connection() {
    return this.connectionManager.getConnection();
  }

  // Private method for serializing data
  private serialize(value: any): string {
    return JSON.stringify(value);
  }

  // Private method for deserializing data
  private deserialize(value: string): any {
    return JSON.parse(value);
  }

  /**
   * Method to save data
   * @param paths Values for generating the key (without prefix)
   * @param data Data to be saved
   */
  async put(paths: Record<string, any>, data: T): Promise<void> {
    const key = this.schema.generateKey(paths);
    const value = this.serialize(data);

    const operation: AbstractBatch = { type: 'put', key, value };

    if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
      // Add operation to the transaction
      this.transactionsRunner.addOperation(operation);
    } else {
      // Execute operation immediately
      return new Promise<void>((resolve, reject) => {
        this.connection.put(key, value, (err: any) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }

  /**
   * Method to delete data
   * @param paths Values for generating the key (without prefix)
   */
  async del(paths: Record<string, any>): Promise<void> {
    const key = this.schema.generateKey(paths);

    const operation: AbstractBatch = { type: 'del', key };

    if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
      // Add operation to the transaction
      this.transactionsRunner.addOperation(operation);
    } else {
      // Execute operation immediately
      return new Promise<void>((resolve, reject) => {
        this.connection.del(key, (err: any) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }

  /**
   * Method to retrieve data by key
   * @param paths Values for generating the key (without prefix)
   * @returns Data or null
   */
  async get(paths: Record<string, any>): Promise<T | null> {
    const key = this.schema.generateKey(paths);

    return new Promise((resolve, reject) => {
      this.connection.get(key, (err: any, value: any) => {
        if (err) {
          if (err.notFound || (err.message && err.message.includes('NotFound'))) {
            return resolve(null);
          }
          return reject(err);
        }
        const data = this.deserialize(value.toString());
        resolve(data);
      });
    });
  }

  /**
   * Method to check if data exists by key
   * @param paths Values for generating the key (without prefix)
   * @returns true if data exists, otherwise false
   */
  async exists(paths: Record<string, any>): Promise<boolean> {
    const data = await this.get(paths);
    return data !== null;
  }

  /**
   * Method to retrieve data by partial key with a filter
   * @param prefixPaths Values for generating the prefix (without prefix)
   * @param filter Data filter function
   * @returns Array of data
   */
  async getByPartialKey(prefixPaths?: Record<string, any>, filter?: (data: T) => boolean): Promise<T[]> {
    const results: T[] = [];

    const prefixKey = this.schema.generatePrefix(prefixPaths);

    return new Promise((resolve, reject) => {
      const iterator = this.connection.iterator({
        gte: prefixKey,
        lte: `${prefixKey}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      const next = () => {
        iterator.next((err: any, key: string, value: string) => {
          if (err) {
            return reject(err);
          }

          if (key === undefined && value === undefined) {
            // End of iteration
            return resolve(results);
          }

          try {
            const data = this.deserialize(value);
            if (!filter || filter(data)) {
              results.push(data);
            }
          } catch (parseError) {
            // Incorrect data, skip the record
          }

          next();
        });
      };

      next();
    });
  }

  /**
   * Method to delete data by partial key
   * @param prefixPaths Values for generating the prefix (without prefix)
   */
  async deleteByPartialKey(prefixPaths?: Record<string, any>): Promise<void> {
    const prefixKey = this.schema.generatePrefix(prefixPaths);

    return new Promise((resolve, reject) => {
      const iterator = this.connection.iterator({
        gte: prefixKey,
        lte: `${prefixKey}\xFF`,
        keyAsBuffer: false,
        keyAsString: true,
      });

      const deleteNextKey = () => {
        iterator.next((err: any, key: string) => {
          if (err) {
            return reject(err);
          }

          if (key === undefined) {
            // End of iteration
            return resolve();
          }

          if (this.transactionsRunner && this.transactionsRunner.isTransactionActive()) {
            // Add operation to the transaction
            this.transactionsRunner.addOperation({ type: 'del', key });
            deleteNextKey();
          } else {
            // Delete the record immediately
            this.connection.del(key, (delErr: any) => {
              if (delErr) return reject(delErr);
              deleteNextKey();
            });
          }
        });
      };

      deleteNextKey();
    });
  }

  /**
   * Method to count the number of records by partial key
   * @param prefixPaths Values for generating the prefix (without prefix)
   * @returns Number of records
   */
  async countByPartialKey(prefixPaths?: Record<string, any>): Promise<number> {
    let count = 0;

    const prefixKey = this.schema.generatePrefix(prefixPaths);

    return new Promise((resolve, reject) => {
      const iterator = this.connection.iterator({
        gte: prefixKey,
        lte: `${prefixKey}\xFF`,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });

      const next = () => {
        iterator.next((err: any, key: any) => {
          if (err) {
            return reject(err);
          }
          if (key === undefined) {
            // End of iteration
            return resolve(count);
          }

          count += 1;
          next();
        });
      };

      next();
    });
  }
}
