import 'reflect-metadata';
import {
  EVENT_METADATA,
  EVENTS_HANDLER_METADATA,
  COMMAND_HANDLER_METADATA,
  QUERY_HANDLER_METADATA,
  SAGA_METADATA,
} from './constants';
import type { Type } from './interfaces';

export function EventsHandler(...events: Type[]) {
  return (target: Type) => {
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, events, target);
  };
}

export function CommandHandler(command: Type) {
  return (target: Type) => {
    Reflect.defineMetadata(COMMAND_HANDLER_METADATA, command, target);
  };
}

export function QueryHandler(query: Type) {
  return (target: Type) => {
    Reflect.defineMetadata(QUERY_HANDLER_METADATA, query, target);
  };
}

export function Saga() {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const sagas: Array<string | symbol> = Reflect.getMetadata(SAGA_METADATA, target.constructor) || [];
    sagas.push(propertyKey);
    Reflect.defineMetadata(SAGA_METADATA, sagas, target.constructor);
    return descriptor;
  };
}

export const setEventMetadata = (event: Type) => {
  Reflect.defineMetadata(EVENT_METADATA, { id: event.name }, event);
};
