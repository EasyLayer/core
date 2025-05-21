import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { deleteDataSourceByName } from 'typeorm-transactional';
import { AppLogger } from '@easylayer/common/logger';

@Injectable()
export class EventStoreService implements OnModuleDestroy {
  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource
  ) {}

  async onModuleDestroy() {
    if (!this.dataSource.isInitialized) {
      this.log.debug('DataSource not initialized, nothing to destroy');
      return;
    }

    const dsName = this.dataSource.options?.name;
    this.log.debug('Shutting down EventStoreService', {
      args: { dataSourceName: dsName },
    });

    try {
      if (dsName) {
        this.log.debug('Deleting transactional DataSource context');
        // TODO: temporary solution
        // Transactional Context is launched within the process, not the application.
        // So if we want it to be available only within the application, we must take care of its destruction.
        // Now we do it here, but it is better to move all this to a module.
        deleteDataSourceByName(dsName);
      }

      this.log.debug('Destroying TypeORM DataSource');
      await this.dataSource.destroy();
      this.log.debug('DataSource destroyed successfully');
    } catch (error) {
      this.log.debug('Error during DataSource destruction', {
        methodName: 'onModuleDestroy',
        args: { error },
      });
    }
  }
}
