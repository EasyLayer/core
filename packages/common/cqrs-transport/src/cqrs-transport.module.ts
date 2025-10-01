import { Module, DynamicModule, Inject, Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { EventBus } from '@easylayer/common/cqrs';
import { OutboxBatchSender } from '@easylayer/common/network-transport';
import { Publisher as CorePublisher, Subscriber as CoreSubscriber } from './core';

export const SYSTEM_MODEL_NAMES = 'SYSTEM_MODEL_NAMES';

@Injectable()
export class PublisherProvider {
  logger: Logger = new Logger(PublisherProvider.name);
  public readonly instance: CorePublisher;

  constructor(@Inject(OutboxBatchSender) outbox: OutboxBatchSender, @Inject(SYSTEM_MODEL_NAMES) modelNames: string[]) {
    // Same wiring as on Node — just uses browser impls of the tokens.
    this.instance = new CorePublisher(outbox, this.logger, modelNames);
  }

  get publisher(): CorePublisher {
    return this.instance;
  }
}

@Injectable()
export class SubscriberProvider implements OnModuleDestroy {
  private logger: Logger = new Logger(SubscriberProvider.name);
  private sub?: CoreSubscriber;

  constructor(
    private readonly pub: PublisherProvider,
    @Inject(EventBus) private readonly eventBus: EventBus
  ) {
    // Subscribe publisher -> EventBus
    this.sub = new CoreSubscriber(this.pub.instance, this.eventBus, this.logger);
  }

  onModuleDestroy() {
    this.sub?.destroy();
  }
}

export interface CqrsTransportModuleOptions {
  isGlobal?: boolean;
  systemAggregates?: string[];
}

@Module({})
export class CqrsTransportModule {
  static forRoot(options?: CqrsTransportModuleOptions): DynamicModule {
    const systemModelNames = options?.systemAggregates || [];
    return {
      module: CqrsTransportModule,
      global: options?.isGlobal || false,
      imports: [],
      providers: [{ provide: SYSTEM_MODEL_NAMES, useValue: systemModelNames }, PublisherProvider, SubscriberProvider],
      exports: [PublisherProvider],
    };
  }
}
