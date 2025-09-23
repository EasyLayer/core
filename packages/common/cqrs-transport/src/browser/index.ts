import type { Logger } from '@nestjs/common';
import type { EventBus } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import type { OutboxBatchSender } from '@easylayer/common/network-transport';
import { Publisher, Subscriber } from '../core';

export type BrowserCqrsTransportOptions = {
  systemAggregates?: string[];
  outbox: OutboxBatchSender;
  eventBus: EventBus;
  logger: Logger;
};

export function createCqrsTransportBrowser(opts: BrowserCqrsTransportOptions) {
  const publisher = new Publisher(opts.outbox, opts.logger, opts.systemAggregates ?? []);
  const subscriber = new Subscriber(publisher, opts.eventBus, opts.logger);

  return {
    publisher,
    destroy() {
      subscriber.destroy();
    },
  };
}

export * from '../core/event-record.interface';
export * from '../cqrs-transport.module';
