import type { Logger } from '@nestjs/common';
import type { EventBus } from '@easylayer/common/cqrs';
import type { OutboxBatchSender } from '@easylayer/common/network-transport';

export type BrowserCqrsTransportOptions = {
  systemAggregates?: string[];
  outbox: OutboxBatchSender;
  eventBus: EventBus;
  logger: Logger;
};

export * from '../core/event-record.interface';
// Use browser-specific module that imports OutboxBatchSender via browser ESM path
// instead of shared module that compiles to relative CJS path
export * from './cqrs-transport.module';
