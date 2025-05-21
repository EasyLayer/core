import 'reflect-metadata';
import type { IEventHandler, IQuery, IQueryHandler } from '@nestjs/cqrs';
import type { Type } from '@nestjs/common';
import {
  EVENT_METADATA,
  EVENTS_HANDLER_METADATA,
  QUERY_METADATA,
  QUERY_HANDLER_METADATA,
} from '@nestjs/cqrs/dist/decorators/constants';
import type { BasicEvent, EventBasePayload } from './basic-event';

/**
 * Sets metadata for an event.
 * This method is used to manually set metadata for an event class.
 * It assigns the metadata 'id' as the name of the event class.
 *
 * @param event The constructor of the event.
 */
export const setEventMetadata = (event: new (...args: any[]) => BasicEvent<EventBasePayload>): void => {
  // IMPORTANT: Method always overwrite the metadata to ensure it is set correctly.
  Reflect.defineMetadata(EVENT_METADATA, { id: event.name }, event);
};

/**
 * Sets metadata for events associated with the given event handlers.
 *
 * @param eventHandlers The array of event handler constructors.
 */
export const setEventMetadataByHandlers = (eventHandlers: Type<IEventHandler>[]) => {
  eventHandlers.forEach((handler: Type<IEventHandler>) => {
    // IMPORTANT: One Event can have few EventHandlers
    const events = Reflect.getMetadata(EVENTS_HANDLER_METADATA, handler) || [];
    events.forEach((event: Type<BasicEvent<EventBasePayload>>) => {
      setEventMetadata(event);
    });
  });
};

/**
 * Sets metadata for a query class so that its `id`
 * matches the query’s constructor name.
 *
 * @param queryCtor The constructor of the query.
 */
export const setQueryMetadata = (query: Type<IQuery>): void => {
  // override the metadata.id to be the constructor’s .name
  Reflect.defineMetadata(QUERY_METADATA, { id: query.name }, query);
};

/**
 * Iterates the given query handler classes, extracts each
 * associated query constructor via @QueryHandler metadata,
 * and sets that query’s metadata.id to its constructor name.
 *
 * @param queryHandlers The array of query handler constructors.
 */
export const setQueryMetadataByHandlers = (queryHandlers: Type<IQueryHandler<any, any>>[]): void => {
  queryHandlers.forEach((handler: Type<IQueryHandler<any, any>>) => {
    // IMPORTANT: One Query can have only one QueryHandler
    const query: Type<IQuery> = Reflect.getMetadata(QUERY_HANDLER_METADATA, handler) || {};
    setQueryMetadata(query);
  });
};
