import type { DynamicModule, OnModuleInit } from '@nestjs/common';
import { Module, Inject } from '@nestjs/common';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { CqrsModule, CommandBus, QueryBus, UnhandledExceptionBus, EventBus } from '@nestjs/cqrs';
import { CustomEventBus } from './custom-event-bus';
import { CustomExplorerService } from './custom-explorer.service';
import { EventPublisher } from './event-publisher';
import type { BasicEvent, EventBasePayload } from './basic-event';

export interface CQRSModuleParameters {
  isGlobal?: boolean;
}

@Module({})
export class CustomCqrsModule<E extends BasicEvent<EventBasePayload> = BasicEvent<EventBasePayload>>
  implements OnModuleInit
{
  static forRoot(parameters: CQRSModuleParameters): DynamicModule {
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
    private readonly explorerService: CustomExplorerService<E>,
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
