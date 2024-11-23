import { promisify } from 'node:util';
import RocksDB from 'rocksdb';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mergeRocksDBOptions, IRocksDBOptions } from './rocksdb.config';

export interface ConnectionOptions {
  database: string;
  type: 'rocksdb' | 'leveldb';
  options: IRocksDBOptions | any;
}

@Injectable()
export class ConnectionManager implements OnModuleInit, OnModuleDestroy {
  private db: any;
  private isOpen: boolean = false;
  private options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    if (options.type !== 'rocksdb') {
      throw new Error('Currently supporting only RocksDB');
    }

    if (!options.database) {
      throw new Error('Database path is missing');
    }

    this.options = options;

    // Initialize the database instance but do not open it yet
    this.db = RocksDB(options.database);
  }

  /**
   * Lifecycle hook that is called after the module has been initialized.
   * Opens the RocksDB database asynchronously.
   */
  async onModuleInit() {
    const rocksdbOptions = mergeRocksDBOptions(this.options.options);

    const openAsync = promisify(this.db.open).bind(this.db);

    try {
      await openAsync(rocksdbOptions);
      this.isOpen = true;
    } catch (err: any) {
      throw new Error(`Failed to open RocksDB: ${err?.message}`);
    }
  }

  /**
   * Lifecycle hook that is called when the module is destroyed.
   * Closes the RocksDB database asynchronously.
   */
  async onModuleDestroy() {
    await this.closeConnection();
  }

  /**
   * Returns the database connection if it is open.
   * Throws an error if the database is not open.
   */
  public getConnection() {
    if (!this.isOpen) {
      throw new Error('Database is not open');
    }
    return this.db;
  }

  /**
   * Closes the database connection if it is open.
   * Sets the isOpen flag to false after closing.
   */
  public async closeConnection() {
    if (!this.isOpen) {
      return;
    }
    const closeAsync = promisify(this.db.close).bind(this.db);
    try {
      await closeAsync();
      this.isOpen = false;
    } catch (err: any) {
      throw new Error(`Failed to close RocksDB: ${err?.message}`);
    }
  }
}
