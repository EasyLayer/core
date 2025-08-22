import { Module, OnModuleInit, Inject, DynamicModule } from '@nestjs/common';
import { EventBus, CustomEventBus } from '@easylayer/common/cqrs';
import { LoggerModule } from '@easylayer/common/logger';
import { Publisher } from './publisher';
import { Subscriber } from './subscriber';

interface CqrsTransportModuleOptions {
  isGlobal?: boolean;
  systemAggregates?: string[];
}

@Module({})
export class CqrsTransportModule implements OnModuleInit {
  static forFeature(): DynamicModule {
    return {
      module: CqrsTransportModule,
      providers: [],
      exports: [Publisher],
    };
  }

  static forRoot(options?: CqrsTransportModuleOptions): DynamicModule {
    const systemModelNames = options?.systemAggregates || [];

    return {
      module: CqrsTransportModule,
      global: options?.isGlobal || false,
      imports: [LoggerModule.forRoot({ componentName: CqrsTransportModule.name })],
      providers: [
        {
          provide: 'SYSTEM_MODEL_NAMES',
          useValue: systemModelNames,
        },
        Publisher,
        Subscriber,
      ],
      exports: [],
    };
  }

  constructor(
    @Inject(EventBus)
    private readonly eventBus: CustomEventBus,
    private readonly publisher: Publisher
  ) {}

  async onModuleInit(): Promise<void> {
    this.eventBus.publisher = this.publisher;
  }
}
