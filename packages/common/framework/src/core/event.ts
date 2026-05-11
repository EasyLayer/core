import { BasicEvent } from '@easylayer/common/cqrs';
import type { SystemFields } from '@easylayer/common/cqrs';

export { BasicEvent };

export type EventCtor<P = any> = new (system: SystemFields, payload: P) => BasicEvent<P>;

// Module-level cache: one constructor object per event name, shared across all Model instances.
// See ADR: adr-ctorcache-as-module-level-map-not-instance-level
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
 * Clears the internal constructor cache.
 *
 * @internal — FOR TEST USE ONLY. Do not call in production code.
 * Importing this function from the public package entrypoint is intentionally
 * not supported. Use a relative internal import in tests:
 *   import { clearEventFactoryCache } from '../core/event';
 *
 * Warning: calling this at runtime invalidates all previously cached constructors.
 * Any existing instances remain valid, but new instances created after the clear
 * will have different constructor objects (breaking instanceof checks across the boundary).
 */
export function clearEventFactoryCache(): void {
  ctorCache.clear();
}
