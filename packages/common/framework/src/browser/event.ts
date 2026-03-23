import { BasicEvent } from '@easylayer/common/cqrs';
import type { SystemFields } from '@easylayer/common/cqrs';

export { BasicEvent };

export type EventCtor<P = any> = new (system: SystemFields, payload: P) => BasicEvent<P>;

const ctorCache = new Map<string, EventCtor>();

/**
 * Creates a class with the exact requested name at runtime.
 * Useful for NestJS CQRS so handlers can resolve by class name.
 * The returned constructor is cached per event name for performance.
 */
export function makeNamedEventCtor<P = any>(eventName: string): EventCtor<P> {
  const cached = ctorCache.get(eventName);
  if (cached) return cached as EventCtor<P>;

  class NamedEvent extends BasicEvent<P> {
    constructor(system: SystemFields, payload: P) {
      super(system, payload);
    }
  }

  // Ensure the constructor has the desired name for handler resolution and debugging
  Object.defineProperty(NamedEvent, 'name', { value: eventName });

  ctorCache.set(eventName, NamedEvent as EventCtor<P>);
  return NamedEvent as EventCtor<P>;
}

/**
 * Convenience helper to create an instance directly.
 */
export function makeNamedEvent<P = any>(eventName: string, system: SystemFields, payload: P): BasicEvent<P> {
  const Ctor = makeNamedEventCtor<P>(eventName);
  return new Ctor(system, payload);
}

/**
 * Clears the internal constructor cache (useful for tests or hot-reload).
 */
export function clearEventFactoryCache(): void {
  ctorCache.clear();
}
