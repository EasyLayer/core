import type { Type } from '@nestjs/common';
import type { IEventHandler } from '@nestjs/cqrs';
import { EVENT_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import type { DomainEvent } from './basic-event';

export interface AggregateOptions {
  /** Enable or disable snapshot creation */
  snapshotsEnabled?: boolean;

  /** Allow pruning of old events/snapshots */
  allowPruning?: boolean;

  /** Interval between snapshots (default: 1000 versions) */
  snapshotInterval?: number;
}

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

  constructor(aggregateId: string, lastBlockHeight: number, options?: AggregateOptions) {
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

  public async republish<T extends E>(event: T): Promise<void> {
    this.setEventMetadata(event);
    await this.publish(event);
  }

  /**
   * Get events that need to be saved to database but haven't been saved yet.
   * These are events added via apply() but not yet persisted.
   */
  public getUnsavedEvents(): E[] {
    // All events in INTERNAL_EVENTS are unsaved until markEventsAsSaved() is called
    return this[INTERNAL_EVENTS];
  }

  /**
   * Get events that have been saved to database but not yet published.
   * With outbox pattern, we don't track this state in aggregate anymore.
   * The outbox table becomes the source of truth for unpublished events.
   */
  public getUncommittedEvents(): E[] {
    // With outbox pattern, we don't need to track uncommitted events in aggregate
    // The outbox table handles this state
    return [];
  }

  /**
   * Mark events as saved to database.
   * Called after successful save to aggregate's event store.
   * Clears the unsaved events array since they're now persisted.
   */
  public markEventsAsSaved(): void {
    this[INTERNAL_EVENTS].length = 0;
  }

  /**
   * Clear all uncommitted events without publishing them.
   * Used in error scenarios or after successful batch publish.
   */
  public uncommit(): void {
    // With outbox pattern, this is handled by outbox cleanup
    // Keep method for compatibility but it's essentially a no-op
  }

  /**
   * Aggregate-level commit is no longer responsible for publishing.
   * Publishing is handled centrally via outbox pattern.
   * This method is kept for interface compatibility but becomes a no-op.
   */
  public async commit(): Promise<void> {
    // No-op: Publishing is handled centrally via outbox
    // Events are published by EventStoreWriteRepository after saving
  }

  /**
   * Checks if the aggregate is ready for snapshot creation.
   * Snapshot cannot be created if there are unsaved or uncommitted events.
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

  public async apply<T extends E>(event: T, options?: { fromHistory?: boolean; skipHandler?: boolean }): Promise<void> {
    const fromHistory = !!options?.fromHistory;
    const skipHandler = !!options?.skipHandler;

    if (!fromHistory) {
      // New event
      this[INTERNAL_EVENTS].push(event);
    }

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

  private setEventMetadata<T extends E>(event: T): void {
    const eventName = this.getEventName(event);
    if (!Reflect.hasOwnMetadata(EVENT_METADATA, event.constructor)) {
      Reflect.defineMetadata(EVENT_METADATA, { id: eventName }, event.constructor);
    }
  }

  private getCircularReplacer() {
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
}
