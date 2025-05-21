import { Module, OnModuleInit, Inject, DynamicModule } from '@nestjs/common';
import { EventBus, CustomEventBus } from '@easylayer/common/cqrs';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { Publisher } from './publisher';
import { Subscriber } from './subscriber';

interface CqrsTransportModuleOptons {
  isGlobal?: boolean;
}

@Module({})
export class CqrsTransportModule implements OnModuleInit {
  static forRoot(options?: CqrsTransportModuleOptons): DynamicModule {
    return {
      module: CqrsTransportModule,
      global: options?.isGlobal || false,
      imports: [LoggerModule.forRoot({ componentName: CqrsTransportModule.name })],
      providers: [Publisher, Subscriber],
      exports: [],
    };
  }

  constructor(
    @Inject(EventBus)
    private readonly eventBus: CustomEventBus,
    private readonly publisher: Publisher,
    private readonly log: AppLogger
  ) {}

  async onModuleInit(): Promise<void> {
    this.log.debug('Linking publisher to EventBus');
    this.eventBus.publisher = this.publisher;
    this.log.debug('Publisher linked');
  }
}
