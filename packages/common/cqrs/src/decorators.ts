import 'reflect-metadata';
import type { BasicEvent, EventBasePayload } from './basic-event';

export const SYSTEM_EVENT_METADATA = '__systemEvent__';

const setEventMetadata = (event: new (...args: any[]) => BasicEvent<EventBasePayload>): void => {
  Reflect.defineMetadata(SYSTEM_EVENT_METADATA, true, event);
};

export const SystemEvent = (): ClassDecorator => {
  return (target: Function) => {
    setEventMetadata(target as new (...args: any[]) => BasicEvent<EventBasePayload>);
  };
};

export function isSystemEvent(event: BasicEvent<EventBasePayload>): boolean {
  return Reflect.getMetadata(SYSTEM_EVENT_METADATA, event.constructor) === true;
}
