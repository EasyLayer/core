import 'reflect-metadata';
import type { DomainEvent } from './basic-event';

export const SYSTEM_EVENT_METADATA = '__systemEvent__';

function setEventMetadata<E extends DomainEvent = DomainEvent>(event: new (...args: any[]) => E): void {
  Reflect.defineMetadata(SYSTEM_EVENT_METADATA, true, event);
}

export const SystemEvent = (): ClassDecorator => {
  return (target: Function) => {
    setEventMetadata(target as unknown as any);
  };
};

export function isSystemEvent<E extends DomainEvent = DomainEvent>(event: E): boolean {
  return Reflect.getMetadata(SYSTEM_EVENT_METADATA, event.constructor) === true;
}
