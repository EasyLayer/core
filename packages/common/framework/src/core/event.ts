import { BasicEvent } from '@easylayer/common/cqrs';
import type { SystemFields } from '@easylayer/common/cqrs';

export { BasicEvent };

export type EventCtor<P = any> = new (system: SystemFields, payload: P) => BasicEvent<P>;

const EVENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9_]*$/;
const MAX_EVENT_NAME_LENGTH = 120;
const MAX_CACHED_EVENT_CONSTRUCTORS = 5_000;

// Module-level cache: one constructor object per event name, shared across all Model instances.
// See ADR: adr-ctorcache-as-module-level-map-not-instance-level
const ctorCache = new Map<string, EventCtor>();

export function assertValidEventName(eventName: string): void {
  if (typeof eventName !== 'string' || eventName.length === 0) {
    throw new Error('eventName is required');
  }

  if (eventName.length > MAX_EVENT_NAME_LENGTH || !EVENT_NAME_PATTERN.test(eventName)) {
    throw new Error(
      `Invalid eventName "${eventName}". ` +
        `Use a PascalCase/identifier-like class name matching ${EVENT_NAME_PATTERN} and max ${MAX_EVENT_NAME_LENGTH} chars.`
    );
  }
}

function rememberConstructor(eventName: string, ctor: EventCtor): void {
  if (ctorCache.size >= MAX_CACHED_EVENT_CONSTRUCTORS) {
    const oldestKey = ctorCache.keys().next().value as string | undefined;
    if (oldestKey) ctorCache.delete(oldestKey);
  }
  ctorCache.set(eventName, ctor);
}

/**
 * Creates a class with the exact requested name at runtime.
 * Useful for NestJS CQRS so handlers can resolve by class name.
 * The returned constructor is cached per validated event name for performance.
 */
export function makeNamedEventCtor<P = any>(eventName: string): EventCtor<P> {
  assertValidEventName(eventName);

  const cached = ctorCache.get(eventName);
  if (cached) return cached as EventCtor<P>;

  class NamedEvent extends BasicEvent<P> {
    constructor(system: SystemFields, payload: P) {
      super(system, payload);
    }
  }

  // Ensure the constructor has the desired name for handler resolution and debugging.
  Object.defineProperty(NamedEvent, 'name', { value: eventName });

  rememberConstructor(eventName, NamedEvent as EventCtor<P>);
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

export function getEventFactoryCacheSize(): number {
  return ctorCache.size;
}
