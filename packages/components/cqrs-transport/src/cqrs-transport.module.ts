import { Module, OnModuleInit, Inject, DynamicModule } from '@nestjs/common';
import { EventBus, CustomEventBus } from '@easylayer/components/cqrs';
import { Publisher } from './publisher';
import { Subscriber } from './subscriber';

@Module({})
export class CqrsTransportModule implements OnModuleInit {
  static forRoot(parameters: any): DynamicModule {
    return {
      module: CqrsTransportModule,
      global: parameters.isGlobal || false,
      imports: [],
      providers: [Publisher, Subscriber],
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
