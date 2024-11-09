import 'reflect-metadata';
import { IEvent, IEventHandler } from '@nestjs/cqrs';
import { Type } from '@nestjs/common';
import { EVENT_METADATA, EVENTS_HANDLER_METADATA } from '@nestjs/cqrs/dist/decorators/constants';

/**
 * Sets metadata for an event.
 * This method is used to manually set metadata for an event class.
 * It assigns the metadata 'id' as the name of the event class.
 *
 * @param event The constructor of the event.
 */
export const setEventMetadata = (event: new (...args: any[]) => IEvent): void => {
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
    const events = Reflect.getMetadata(EVENTS_HANDLER_METADATA, handler) || [];
    events.forEach((event: Type<IEvent>) => {
      setEventMetadata(event);
    });
  });
};
