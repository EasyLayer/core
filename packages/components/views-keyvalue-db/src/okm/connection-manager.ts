import RocksDB from 'rocksdb';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { mergeRocksDBOptions, IRocksDBOptions } from './rocksdb.config';

export interface ConnectionOptions {
  database: string;
  type: 'rocksdb' | 'leveldb';
  options: IRocksDBOptions | any;
}

@Injectable()
export class ConnectionManager implements OnModuleDestroy {
  private db: any;

  constructor({ type, database, options }: ConnectionOptions) {
    if (type !== 'rocksdb') {
      throw new Error('Now mainteing only RocksDB');
    }

    if (!database) {
      throw new Error('database is missed');
    }

    const rocksdbOptions = mergeRocksDBOptions(options);

    this.db = RocksDB(database);
    this.db.open(rocksdbOptions, (err: any) => {
      if (err) throw err;
    });
  }

  onModuleDestroy() {
    this.db.close((err: any) => {
      if (err) throw err;
    });
  }

  //TODO: add destroy

  public getConnection() {
    return this.db;
  }

  public closeConnection() {
    this.db.close((err: any) => {
      if (err) throw err;
    });
  }
}
