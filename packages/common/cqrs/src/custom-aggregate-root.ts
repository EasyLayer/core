import type { Type } from '@nestjs/common';
import type { IEventHandler } from '@nestjs/cqrs';
import { EVENT_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import type { SystemFields, DomainEvent } from './basic-event';
import { EventStatus } from './basic-event';

const INTERNAL_EVENTS = Symbol();

/**
 * Helpers for snapshot transforming specific fields
 * for exotic structures;
 * Map/Set/BigInt/Date handled automatically.
 */
export type SnapshotFieldAdapter = {
  toJSON: (value: any) => any;
  fromJSON: (raw: any) => any;
};

// ===== Built-in snapshot replacer / reviver =====
// - Serializes Map/Set/Date/BigInt
// - Respects user-provided field adapters (if any)
function snapshotReplacer(adapters?: Record<string, SnapshotFieldAdapter>) {
  const seen = new WeakSet();
  return function (key: string, value: any) {
    if (adapters && key && adapters[key]) return adapters[key]!.toJSON(value);
    if (typeof value === 'bigint') return { __t: 'BigInt', v: value.toString() };
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return;
      seen.add(value);
      if (value instanceof Map) return { __t: 'Map', v: Array.from(value.entries()) };
      if (value instanceof Set) return { __t: 'Set', v: Array.from(value.values()) };
      if (value instanceof Date) return { __t: 'Date', v: value.toISOString() };
    }
    return value;
  };
}
function snapshotReviver(adapters?: Record<string, SnapshotFieldAdapter>) {
  return function (key: string, value: any) {
    if (adapters && key && adapters[key]) return adapters[key]!.fromJSON(value);
    if (value && typeof value === 'object' && '__t' in value) {
      switch (value.__t) {
        case 'Map':
          return new Map(value.v);
        case 'Set':
          return new Set(value.v);
        case 'Date':
          return new Date(value.v);
        case 'BigInt':
          return BigInt(value.v);
      }
    }
    return value;
  };
}

// ===== Dynamic event class factory =====
// const eventClassCache = new Map<string, any>();
function makeEventClass(eventName: string) {
  // if (eventClassCache.has(eventName)) return eventClassCache.get(eventName);
  // Create a class with constructor.name === eventName
  const EventClass = new Function(`
    return class ${eventName} { constructor(payload){ this.payload = payload; } }
  `)();
  // Attach Nest CQRS metadata so EventBus knows the id
  Reflect.defineMetadata(EVENT_METADATA, { id: eventName }, EventClass);
  // eventClassCache.set(eventName, EventClass);
  return EventClass;
}

export abstract class CustomAggregateRoot<E extends DomainEvent = DomainEvent> {
  private readonly [INTERNAL_EVENTS]: E[] = [];
  private _version: number;
  private _aggregateId: string;
  private _lastBlockHeight: number;
  private _versionsFromSnapshot: number;

  // Snapshot control parameters
  private _snapshotsEnabled: boolean = true;
  private _snapshotInterval: number = 1000;

  // Pruning control parameter
  private _allowPruning: boolean = false;

  // OPTIONAL: per-field snapshot adapters on child classes
  // static snapshotFieldAdapters?: Record<string, SnapshotFieldAdapter>;

  constructor(
    aggregateId: string,
    lastBlockHeight: number,
    options?: {
      snapshotsEnabled?: boolean;
      allowPruning?: boolean;
      snapshotInterval?: number;
    }
  ) {
    if (!aggregateId) throw new Error('aggregateId is required');
    this._aggregateId = aggregateId;
    this._lastBlockHeight = lastBlockHeight;
    this._version = 0;
    this._versionsFromSnapshot = 0;

    if (options?.snapshotsEnabled !== undefined) this._snapshotsEnabled = options.snapshotsEnabled;
    if (options?.allowPruning !== undefined) this._allowPruning = options.allowPruning;
    if (options?.snapshotInterval !== undefined) this._snapshotInterval = options.snapshotInterval;
  }

  get aggregateId() {
    return this._aggregateId;
  }
  get version() {
    return this._version;
  }
  get lastBlockHeight() {
    return this._lastBlockHeight;
  }
  get versionsFromSnapshot() {
    return this._versionsFromSnapshot;
  }
  get snapshotInterval() {
    return this._snapshotInterval;
  }

  /**
   * Indicates whether old events can be pruned for this aggregate.
   * When enabled, old events beyond the retention period can be safely deleted
   * to save storage space, provided there are appropriate snapshots.
   * When disabled, all events are preserved for complete audit trail.
   *
   * Also, indicates whether old snapshots should be automatically pruned when creating new ones.
   * When enabled, only the latest snapshot is kept to save storage space.
   * When disabled, all snapshots are preserved for historical access.
   *
   * IMPORTANT: Pruning should only be enabled for aggregates that:
   * 1. Can safely reconstruct state from any point in event history
   * 2. Don't require complete event audit trail for compliance
   */
  get allowPruning(): boolean {
    return this._allowPruning;
  }

  /**
   * Indicates whether snapshots should be created for this aggregate.
   * When disabled, the aggregate will only rely on event sourcing for state reconstruction.
   */
  get snapshotsEnabled(): boolean {
    return this._snapshotsEnabled;
  }

  // Method to reset snapshot counter (called after creating snapshot)
  public resetSnapshotCounter(): void {
    this._versionsFromSnapshot = 0;
  }

  public async publish<T extends E>(event: T): Promise<void> {}

  public async publishAll<T extends E>(events: T[]): Promise<void> {}

  /**
   * Publishes an event.
   * This method sets the event metadata before publishing it.
   *
   * @param event The event to be published.
   */
  public async republish<T extends E>(event: T): Promise<void> {
    this.setEventMetadata(event);
    await this.publish(event);
  }

  /**
   * Publish all uncommitted events and then clear them
   * This is the main commit method called from repository
   */
  public async commit(): Promise<void> {
    const events = this.getUncommittedEvents();
    if (events.length > 0) {
      await this.publishAll(events);
    }
    this.uncommit(); // Clear all events after successful publish
  }

  /**
   * Get events that are saved but not yet published (uncommitted)
   * These are all saved events since uncommit() clears published ones
   */
  public getUncommittedEvents(): E[] {
    return this[INTERNAL_EVENTS].filter((e) => e.status === EventStatus.UNPUBLISHED);
  }

  /**
   * Clear all stored events
   * Called after successful publish or for rollback scenarios
   */
  public uncommit(): void {
    this[INTERNAL_EVENTS].length = 0;
  }

  /**
   * Get events that need to be saved to database
   * Does NOT change state - just returns unsaved events
   */
  public getUnsavedEvents(): E[] {
    return this[INTERNAL_EVENTS].filter((e) => e.status === EventStatus.UNSAVED);
  }

  /**
   * Mark events as saved to database
   * Call this ONLY after successful database save
   */
  public markEventsAsSaved(): void {
    for (const e of this[INTERNAL_EVENTS]) {
      if (e.status === EventStatus.UNSAVED) e.status = EventStatus.UNPUBLISHED;
    }
  }

  /**
   * Checks if the aggregate is ready for snapshot creation.
   * Snapshot cannot be created if there are unsaved or uncommitted events.
   *
   * @returns true if snapshot can be safely created
   */
  public canMakeSnapshot(): boolean {
    // Check if snapshots are enabled for this aggregate
    if (!this.snapshotsEnabled) {
      return false;
    }

    // Check if snapshot interval is reached
    if (this.versionsFromSnapshot < this.snapshotInterval) {
      return false;
    }

    // IMPORTANT: Cannot make snapshot if there are any events in INTERNAL_EVENTS
    // These events need to be saved and published first
    if (this[INTERNAL_EVENTS].length > 0) {
      return false;
    }

    return true;
  }

  public async loadFromHistory<T extends E>(history: T[]): Promise<void> {
    for (const event of history) {
      await this.apply(event, { fromHistory: true, skipHandler: false });
    }
  }

  /**
   * Apply new event (not from history)
   * Events start as unsaved
   */
  public async apply<T extends E>(event: T, options?: { fromHistory?: boolean; skipHandler?: boolean }): Promise<void> {
    const fromHistory = !!options?.fromHistory;
    const skipHandler = !!options?.skipHandler;

    if (!fromHistory) {
      // New event: not saved
      if (event.status !== EventStatus.UNSAVED) event.status = EventStatus.UNSAVED;
      this[INTERNAL_EVENTS].push(event);
    } else if (fromHistory && event.status === EventStatus.UNPUBLISHED) {
      // From history: saved but not published - add to array for future publishing
      this[INTERNAL_EVENTS].push(event);
    }

    // IMPORTANT: If status is PUBLISHED or RECEIVED, we don't add to array
    // These events are already published, we only need them for state reconstruction

    if (!skipHandler) {
      const handler = this.getEventHandler(event);
      if (handler) {
        handler.call(this, event);
        this._version++;
        this._versionsFromSnapshot++;
        this._lastBlockHeight = event.blockHeight ?? this._lastBlockHeight;
      }
    }
  }

  public toSnapshot(): string {
    // IMPORTANT: We do not put the values _version, _aggregateId, _lastBlockHeight in the payload,
    // they are saved at the top level of snapshot

    const systemPayload = this.collectSystemProps();
    const userPayload = this.serializeUserState();

    const payload: any = {
      __type: this.constructor.name,
      ...systemPayload,
      ...userPayload,
    };

    const adapters = (this.constructor as any).snapshotFieldAdapters as
      | Record<string, SnapshotFieldAdapter>
      | undefined;

    return JSON.stringify(payload, snapshotReplacer(adapters));
  }

  public fromSnapshot({
    aggregateId,
    version,
    blockHeight,
    payload,
  }: {
    aggregateId: string;
    version: number;
    blockHeight: number;
    payload: Record<string, any>;
  }): void {
    this.constructor = { name: payload.__type } as typeof Object.constructor;

    if (!aggregateId) {
      throw new Error('aggregate Id is missed');
    }

    if (blockHeight == null) {
      throw new Error('lastBlockHeight is missing');
    }

    if (version == null) {
      throw new Error('version is missing');
    }

    this._aggregateId = aggregateId;
    this._version = version;
    this._lastBlockHeight = blockHeight;
    this._versionsFromSnapshot = 0; // Reset counter when loading from snapshot

    const adapters = (this.constructor as any).snapshotFieldAdapters as
      | Record<string, SnapshotFieldAdapter>
      | undefined;

    const revived = JSON.parse(JSON.stringify(payload), snapshotReviver(adapters));

    // IMPORTANT: We don't need to restore the prototype and properties since restoreUserState() is not a static method,
    // but a method inside an instance of the base aggregate.
    // const instance = Object.create(CustomAggregateRoot.prototype);
    // Object.assign(this, instance);
    this.restoreUserState(revived);
  }

  // IMPORTANT: This method can be overridden by user for custom transformations
  // System fields are always excluded at toSnapshotPayload level
  protected serializeUserState(): any {
    // Default implementation returns empty object
    // User can override this method in derived classes for custom transformations
    return {};
  }

  // IMPORTANT: When an aggregate inherits from CustomAggregateRoot
  // and has complex structures in its properties, for the restoration of which a prototype is required,
  // then this restoreUserState method must be overridden in the aggregate itself,
  // since it has access to the classes of its structures.
  protected restoreUserState(state: any): void {
    Object.assign(this, state);
  }

  // IMPORTANT: System part - always executes, automatically serializes all properties
  // except system fields. User cannot override this method.
  private collectSystemProps(): any {
    const result: any = {};

    // Excluded system fields - manually defined array
    const excludedFields = [
      '_version',
      '_aggregateId',
      '_lastBlockHeight',
      '_versionsFromSnapshot',
      INTERNAL_EVENTS.toString(),
    ];

    // Get all own properties
    const allKeys = [...Object.getOwnPropertyNames(this), ...Object.getOwnPropertySymbols(this)];

    for (const key of allKeys) {
      const keyString = key.toString();

      // Skip excluded system fields
      if (excludedFields.includes(keyString)) {
        continue;
      }

      // Skip methods
      if (typeof (this as any)[key] === 'function') {
        continue;
      }

      result[key] = (this as any)[key];
    }

    return result;
  }

  protected getEventHandler<T extends E>(event: T): Type<IEventHandler> | undefined {
    const handler = `on${this.getEventName(event)}`;

    //@ts-ignore
    return this[handler];
  }

  protected getEventName(event: any): string {
    const { constructor } = Object.getPrototypeOf(event);
    return constructor.name as string;
  }

  /**
   * Sets metadata for an event.
   * This method assigns the event's metadata 'id' as the event name.
   *
   * @param event The event for which metadata should be set.
   */
  protected setEventMetadata<T extends E>(event: T): void {
    const eventName = this.getEventName(event);
    if (!Reflect.hasOwnMetadata(EVENT_METADATA, event.constructor)) {
      Reflect.defineMetadata(EVENT_METADATA, { id: eventName }, event.constructor);
    }
  }

  protected getCircularReplacer() {
    const seen = new WeakSet();
    return function (key: any, value: any) {
      // Check is used to ensure that the current value is an object but not null (since typeof null === 'object).
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          // If the object has already been processed (i.e. it is in a WeakSet),
          // this means that a circular reference has been found and the function returns undefined instead,
          // (which prevents the circular reference from being serialized).
          // Skip cyclic references
          return;
        }
        // If the object has not yet been seen,
        // it is added to the WeakSet using seen.add(value)
        // to keep track of which objects have already been processed.
        seen.add(value);
      }
      return value;
    };
  }

  /**
   * Internal helper for compilers:
   * Create a concrete event class (constructor.name === type), attach system fields on top-level.
   *
   * Back-compat: if userPayload contains blockHeight/requestId/timestamp —
   * we lift them to top-level system fields and remove from payload.
   */
  protected createEvent<P = any>(
    type: string,
    userPayload: P & Partial<Pick<SystemFields, 'blockHeight' | 'requestId' | 'timestamp'>>,
    overrides?: Partial<Pick<SystemFields, 'blockHeight' | 'requestId' | 'timestamp' | 'status'>>
  ): E {
    const EventClass = makeEventClass(type);

    // extract meta from payload (back-compat with existing user code)
    const {
      blockHeight: bhFromPayload,
      requestId: ridFromPayload,
      timestamp: tsFromPayload,
      ...clean
    } = (userPayload ?? {}) as any;

    const instance: any = new EventClass(clean);
    instance.aggregateId = this._aggregateId;
    instance.requestId = overrides?.requestId ?? ridFromPayload;
    instance.blockHeight = overrides?.blockHeight ?? bhFromPayload ?? this._lastBlockHeight;
    instance.timestamp = overrides?.timestamp ?? tsFromPayload ?? Date.now();
    instance.status = overrides?.status ?? EventStatus.UNSAVED;

    return instance as E;
  }
}
