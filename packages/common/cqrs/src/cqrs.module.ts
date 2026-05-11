import type { DynamicModule, Provider, Type } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { IEventHandler, ICommandHandler, IQueryHandler } from './interfaces';
import {
  EVENT_HANDLER_INSTANCES,
  COMMAND_HANDLER_INSTANCES,
  QUERY_HANDLER_INSTANCES,
  SAGA_CLASS_INSTANCES,
  SAGA_FUNCTIONS,
  SAGA_FACTORIES_INLINE,
  SAGA_METADATA,
} from './constants';
import { EventBus } from './event-bus';
import { CommandBus } from './command-bus';
import { QueryBus } from './query-bus';
import { UnhandledExceptionBus } from './unhandled-exception-bus';

export interface CQRSModuleParameters {
  isGlobal?: boolean;
  events?: Type<IEventHandler>[];
  commands?: Type<ICommandHandler>[];
  queries?: Type<IQueryHandler>[];
  // Maximum time in milliseconds a single event handler is allowed to run.
  // If a handler exceeds this deadline, an error is logged, routed to
  // UnhandledExceptionBus, and the event stream continues with the next event.
  // Defaults to 30 000 ms (30 seconds). Set to 0 to disable.
  handlerTimeoutMs?: number;
}

@Module({})
export class CqrsModule {
  static forRoot(params: CQRSModuleParameters = {}): DynamicModule {
    const eventClasses = params.events ?? [];
    const commandClasses = params.commands ?? [];
    const queryClasses = params.queries ?? [];
    // const sagaClasses = (params.sagas ?? []).filter((s: any) => typeof s === 'function' && s.prototype) as Type[];
    // const sagaFactories = (params.sagas ?? []).filter(
    //   (s: any) => typeof s === 'function' && !s.prototype
    // ) as Function[];

    // We put ALL classes in providers so that Nest can create instances with DI
    const handlerProviders: Provider[] = [...eventClasses, ...commandClasses, ...queryClasses]; //...sagaClasses

    // Aggregate instances into arrays without ModuleRef
    const aggregatorProviders: Provider[] = [
      {
        provide: EVENT_HANDLER_INSTANCES,
        useFactory: (...handlers: any[]) => handlers,
        inject: eventClasses,
      },
      {
        provide: COMMAND_HANDLER_INSTANCES,
        useFactory: (...handlers: any[]) => handlers,
        inject: commandClasses,
      },
      {
        provide: QUERY_HANDLER_INSTANCES,
        useFactory: (...handlers: any[]) => handlers,
        inject: queryClasses,
      },
      // {
      //   provide: SAGA_CLASS_INSTANCES,
      //   useFactory: (...instances: any[]) => instances,
      //   inject: sagaClasses,
      // },
      // { provide: SAGA_FACTORIES_INLINE, useValue: sagaFactories },
      // {
      //   provide: SAGA_FUNCTIONS,
      //   useFactory: (classes: any[], factories: Function[]) => {
      //     const fns: Function[] = [...factories];
      //     for (const inst of classes) {
      //       const keys: string[] = Reflect.getMetadata(SAGA_METADATA, inst.constructor) || [];
      //       for (const k of keys) fns.push(inst[k].bind(inst));
      //     }
      //     return fns;
      //   },
      //   inject: [SAGA_CLASS_INSTANCES, SAGA_FACTORIES_INLINE],
      // },
    ];

    const wireUp: Provider = {
      provide: 'CQRS_WIRE_UP',
      useFactory: (
        eb: EventBus,
        cb: CommandBus,
        qb: QueryBus,
        unhandled: UnhandledExceptionBus,
        eventHandlers: any[],
        commandHandlers: any[],
        queryHandlers: any[]
        // sagaFns: Array<(events$: any) => any>
      ) => {
        eb.bindCommandBus(cb);
        eb.bindUnhandledBus(unhandled);
        // Configure handler timeout before registering instances.
        // If not provided, EventBus uses its built-in default (30 000 ms).
        if (params.handlerTimeoutMs !== undefined) {
          eb.setHandlerTimeout(params.handlerTimeoutMs);
        }
        eb.registerInstances(eventHandlers);
        // eb.registerSagaFunctions(sagaFns);
        cb.registerInstances(commandHandlers);
        qb.registerInstances(queryHandlers);
      },
      inject: [
        EventBus,
        CommandBus,
        QueryBus,
        UnhandledExceptionBus,
        EVENT_HANDLER_INSTANCES,
        COMMAND_HANDLER_INSTANCES,
        QUERY_HANDLER_INSTANCES,
        // SAGA_FUNCTIONS,
      ],
    };

    return {
      module: CqrsModule,
      global: !!params.isGlobal,
      providers: [
        EventBus,
        CommandBus,
        QueryBus,
        UnhandledExceptionBus,
        ...handlerProviders,
        ...aggregatorProviders,
        wireUp,
      ],
      exports: [EventBus, CommandBus, QueryBus, UnhandledExceptionBus],
    };
  }
}
