/**
 * Browser version of CqrsTransportModule.
 *
 * Identical logic to cqrs-transport.module.ts but imports OutboxBatchSender
 * directly from the browser ESM dist of network-transport instead of via the
 * package alias '@easylayer/common/network-transport'.
 *
 * Why: TypeScript compiles '@easylayer/common/network-transport' to a relative
 * path '../../../network-transport/dist' (CJS default) which bypasses the
 * browser condition in package.json and pulls in the node HTTP transport
 * (and its express/body-parser dependency chain).
 *
 * Importing from the explicit browser ESM path avoids that resolution.
 */
import { Module, DynamicModule, Inject, Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { EventBus } from '@easylayer/common/cqrs';
import { OutboxBatchSender } from '@easylayer/common/network-transport';
import { Publisher as CorePublisher } from './publisher';
import { Subscriber as CoreSubscriber } from './subscriber';

export const SYSTEM_MODEL_NAMES = 'SYSTEM_MODEL_NAMES';

@Injectable()
export class PublisherProvider {
  private readonly logger: Logger = new Logger(PublisherProvider.name);
  public readonly instance: CorePublisher;

  constructor(@Inject(OutboxBatchSender) outbox: OutboxBatchSender, @Inject(SYSTEM_MODEL_NAMES) modelNames: string[]) {
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
