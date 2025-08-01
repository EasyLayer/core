import type { Type } from '@nestjs/common';
import type { IEventHandler } from '@nestjs/cqrs';
import { EVENT_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import type { BasicEvent, EventBasePayload } from './basic-event';

const INTERNAL_EVENTS = Symbol();

export enum EventStatus {
  UNPUBLISHED = 'UNPUBLISHED', // saved at db and not published
  PUBLISHED = 'PUBLISHED', // published on transport
  RECEIVED = 'RECEIVED', // received confirm from user
}

export type HistoryEvent<E extends BasicEvent<EventBasePayload>> = {
  event: E;
  status: EventStatus;
};

interface StoredEvent<E extends BasicEvent<EventBasePayload>> {
  event: E;
  isSaved: boolean;
}

export abstract class CustomAggregateRoot<E extends BasicEvent<EventBasePayload> = BasicEvent<EventBasePayload>> {
  private readonly [INTERNAL_EVENTS]: StoredEvent<E>[] = [];
  protected _version: number = 0;
  protected _aggregateId: string;
  protected _lastBlockHeight: number;
  private _versionsFromSnapshot: number = 0;

  // Snapshot control parameters
  private _snapshotsEnabled: boolean = true;
  private _pruneOldSnapshots: boolean = false;

  // Event pruning control parameter
  private _allowEventsPruning: boolean = false;

  constructor(
    aggregateId: string,
    lastBlockHeight = -1,
    options?: {
      snapshotsEnabled?: boolean;
      pruneOldSnapshots?: boolean;
      allowEventsPruning?: boolean;
    }
  ) {
    if (!aggregateId) throw new Error('aggregateId is required');
    this._aggregateId = aggregateId;
    this._lastBlockHeight = lastBlockHeight;

    // Set snapshot options if provided
    if (options?.snapshotsEnabled !== undefined) {
      this._snapshotsEnabled = options.snapshotsEnabled;
    }
    if (options?.pruneOldSnapshots !== undefined) {
      this._pruneOldSnapshots = options.pruneOldSnapshots;
    }
    if (options?.allowEventsPruning !== undefined) {
      this._allowEventsPruning = options.allowEventsPruning;
    }
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

  /**
   * Indicates whether old events can be pruned for this aggregate.
   * When enabled, old events beyond the retention period can be safely deleted
   * to save storage space, provided there are appropriate snapshots.
   * When disabled, all events are preserved for complete audit trail.
   *
   * IMPORTANT: Event pruning should only be enabled for aggregates that:
   * 1. Can safely reconstruct state from any point in event history
   * 2. Don't require complete event audit trail for compliance
   */
  get allowEventsPruning(): boolean {
    return this._allowEventsPruning;
  }

  /**
   * Indicates whether snapshots should be created for this aggregate.
   * When disabled, the aggregate will only rely on event sourcing for state reconstruction.
   */
  get snapshotsEnabled(): boolean {
    return this._snapshotsEnabled;
  }

  /**
   * Indicates whether old snapshots should be automatically pruned when creating new ones.
   * When enabled, only the latest snapshot is kept to save storage space.
   * When disabled, all snapshots are preserved for historical access.
   */
  get pruneOldSnapshots(): boolean {
    return this._pruneOldSnapshots;
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

  public async commit(): Promise<void> {
    const events = this.getUncommittedEvents();
    await this.publishAll(events);
    this.uncommit();
  }

  /**
   * Returns all events (both saved and unsaved)
   */
  public getUncommittedEvents(): E[] {
    return this[INTERNAL_EVENTS].map((wrapper) => wrapper.event);
  }

  /**
   * Clears all stored events
   */
  public uncommit(): void {
    this[INTERNAL_EVENTS].length = 0;
  }

  /**
   * Returns only events not yet saved to the database,
   * marking them as saved in the process
   */
  public getUnsavedEvents(): E[] {
    const result: E[] = [];
    for (const wrapper of this[INTERNAL_EVENTS]) {
      if (!wrapper.isSaved) {
        result.push(wrapper.event);
        wrapper.isSaved = true;
      }
    }
    return result;
  }

  public async loadFromHistory<T extends E>(history: HistoryEvent<T>[]): Promise<void> {
    for (const { event, status } of history) {
      await this.apply(event, {
        fromHistory: true,
        skipHandler: false,
        status,
      });
    }
  }

  public async apply<T extends E>(
    event: T,
    optionsOrIsFromHistory?: boolean | { fromHistory?: boolean; skipHandler?: boolean; status?: EventStatus }
  ): Promise<void> {
    let isFromHistory = false;
    let skipHandler = false;
    let status = EventStatus.UNPUBLISHED;

    if (typeof optionsOrIsFromHistory === 'boolean') {
      isFromHistory = optionsOrIsFromHistory;
    } else if (optionsOrIsFromHistory) {
      isFromHistory = optionsOrIsFromHistory.fromHistory ?? false;
      skipHandler = optionsOrIsFromHistory.skipHandler ?? false;
      status = optionsOrIsFromHistory.status ?? EventStatus.UNPUBLISHED;
    }

    if (!isFromHistory) {
      // IMPORTANT: when we add event first time - isSaved = false
      this[INTERNAL_EVENTS].push({ event, isSaved: false });
    }

    if (isFromHistory && status === EventStatus.UNPUBLISHED) {
      // IMPORTANT: when we add event from history - this means it come from db
      this[INTERNAL_EVENTS].push({ event, isSaved: true });
    }

    if (!skipHandler) {
      const handler = this.getEventHandler(event);
      if (handler) {
        handler.call(this, event);
        this._version++;
        this._versionsFromSnapshot++;
        this._lastBlockHeight = event.payload.blockHeight;
      }
    }
  }

  public toSnapshotPayload(): string {
    // IMPORTANT: We do not put the values _version, _aggregateId, _lastBlockHeight in the payload,
    // they are saved at the top level of snapshot

    const systemPayload = this.getSystemPayload();
    const userPayload = this.toJsonPayload();

    const payload: any = {
      __type: this.constructor.name,
      ...systemPayload,
      ...userPayload,
    };
    return JSON.stringify(payload, this.getCircularReplacer());
  }

  public loadFromSnapshot({
    aggregateId,
    version,
    blockHeight,
    payload,
  }: {
    aggregateId: string;
    version: number;
    blockHeight: number;
    payload: any;
  }): void {
    const deserializedPayload = JSON.parse(payload);

    this.constructor = { name: deserializedPayload.__type } as typeof Object.constructor;

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

    // IMPORTANT: We don't need to restore the prototype and properties since loadFromSnapshot() is not a static method,
    // but a method inside an instance of the base aggregate.
    // const instance = Object.create(CustomAggregateRoot.prototype);
    // Object.assign(this, instance);
    this.fromSnapshot(deserializedPayload);
  }

  // IMPORTANT: This method can be overridden by user for custom transformations
  // System fields are always excluded at toSnapshotPayload level
  protected toJsonPayload(): any {
    // Default implementation returns empty object
    // User can override this method in derived classes for custom transformations
    return {};
  }

  // IMPORTANT: When an aggregate inherits from CustomAggregateRoot
  // and has complex structures in its properties, for the restoration of which a prototype is required,
  // then this fromSnapshot method must be overridden in the aggregate itself,
  // since it has access to the classes of its structures.
  protected fromSnapshot(state: any): void {
    Object.assign(this, state);
  }

  // IMPORTANT: System part - always executes, automatically serializes all properties
  // except system fields. User cannot override this method.
  private getSystemPayload(): any {
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

  protected getEventHandler<E extends BasicEvent<EventBasePayload>>(event: E): Type<IEventHandler> | undefined {
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
  protected setEventMetadata<E extends BasicEvent<EventBasePayload>>(event: E): void {
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
}
