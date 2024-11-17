import RocksDB from 'rocksdb';
import { Injectable } from '@nestjs/common';

@Injectable()
export class ConnectionManager {
  private db: any;

  constructor(database: string, type: string) {
    if (type !== 'rocksdb') {
      throw new Error('Now mainteing only RocksDB');
    }

    this.db = RocksDB(database);
    this.db.open({ create_if_missing: true }, (err: any) => {
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
