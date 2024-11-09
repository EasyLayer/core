import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class EventStoreService {
  // implements OnModuleDestroy {
  constructor(private dataSource: DataSource) {}

  // async onModuleDestroy() {
  //   if (this.dataSource.isInitialized) {
  //     await this.dataSource.destroy();
  //   }
  // }
}
