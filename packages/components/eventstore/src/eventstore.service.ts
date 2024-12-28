import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { deleteDataSourceByName } from 'typeorm-transactional';
import { DataSource } from 'typeorm';

@Injectable()
export class EventStoreService implements OnModuleDestroy {
  constructor(private dataSource: DataSource) {}

  async onModuleDestroy() {
    if (this.dataSource.isInitialized) {
      try {
        // TODO: temporary solution
        // Transactional Context is launched within the process, not the application.
        // So if we want it to be available only within the application, we must take care of its destruction.
        // Now we do it here, but it is better to move all this to a module.
        if (this.dataSource.options?.name) {
          deleteDataSourceByName(this.dataSource.options.name);
        }

        await this.dataSource.destroy();
      } catch (error) {
        // TODO
        throw error;
      }
    }
  }
}
