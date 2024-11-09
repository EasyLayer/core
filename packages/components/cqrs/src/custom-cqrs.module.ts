import { Module, DynamicModule, OnModuleInit, Inject } from '@nestjs/common';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { CqrsModule, CommandBus, QueryBus, UnhandledExceptionBus, IEvent, EventBus } from '@nestjs/cqrs';
import { CustomEventBus } from './custom-event-bus';
import { CustomExplorerService } from './custom-explorer.service';
import { EventPublisher } from './event-publisher';

export interface CQRSModuleParameters<EB extends EventBus = EventBus, EP extends EventPublisher = EventPublisher> {
  isGlobal?: boolean;
  eventBus?: EB;
  publisher?: EP;
}

// @Global()
@Module({})
export class CustomCqrsModule<EventBase extends IEvent = IEvent> implements OnModuleInit {
  static forRoot(parameters: CQRSModuleParameters): DynamicModule {
    // const { eventBus, publisher } = parameters;

    // if (eventBus)
    // if (publisher)

    return {
      module: CustomCqrsModule,
      global: parameters.isGlobal || false,
      imports: [CqrsModule],
      providers: [
        CommandBus,
        QueryBus,
        UnhandledExceptionBus,
        {
          provide: CustomExplorerService,
          useFactory: (modulesContainer) => {
            return new CustomExplorerService(modulesContainer);
          },
          inject: [ModulesContainer],
        },
        {
          provide: EventPublisher,
          useFactory: (eventBus) => {
            return new EventPublisher(eventBus);
          },
          inject: [EventBus],
        },
        {
          provide: EventBus,
          useFactory: (commandBus: CommandBus, moduleRef: ModuleRef, unhandledExceptionBus: UnhandledExceptionBus) =>
            new CustomEventBus(commandBus, moduleRef, unhandledExceptionBus),
          inject: [CommandBus, ModuleRef, UnhandledExceptionBus],
        },
      ],
      exports: [CommandBus, QueryBus, EventBus, EventPublisher, EventBus, UnhandledExceptionBus],
    };
  }

  constructor(
    private readonly explorerService: CustomExplorerService<EventBase>,
    @Inject(EventBus)
    private readonly eventBus: CustomEventBus,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus
  ) {}

  onModuleInit() {
    const { events, queries, sagas, commands } = this.explorerService.explore();
    this.eventBus.register(events);
    this.eventBus.registerSagas(sagas);
    this.commandBus.register(commands);
    this.queryBus.register(queries);
  }
}
