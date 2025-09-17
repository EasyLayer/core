import 'reflect-metadata';
import type { Type, IEventHandler, IQuery, IQueryHandler } from './interfaces';
import { EVENT_METADATA, EVENTS_HANDLER_METADATA, QUERY_METADATA, QUERY_HANDLER_METADATA } from './constants';
import { setEventMetadata as _setEventMetadata } from './decorators';

export const setEventMetadata = (event: Type<any>): void => {
  Reflect.defineMetadata(EVENT_METADATA, { id: (event as any).name }, event);
};

export const setEventMetadataByHandlers = (eventHandlers: Type<IEventHandler>[]) => {
  eventHandlers.forEach((handler) => {
    // IMPORTANT: One Event can have few EventHandlers
    const events: Type[] = Reflect.getMetadata(EVENTS_HANDLER_METADATA, handler) || [];
    events.forEach((event: Type) => _setEventMetadata(event));
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

export const setQueryMetadataByHandlers = (queryHandlers: Type<IQueryHandler<any, any>>[]): void => {
  queryHandlers.forEach((handler) => {
    // IMPORTANT: One Query can have only one QueryHandler
    const query: Type<IQuery> = Reflect.getMetadata(QUERY_HANDLER_METADATA, handler);
    if (query) setQueryMetadata(query);
  });
};
