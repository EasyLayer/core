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

  /** Optional per-field snapshot adapters (instance-level) */
  snapshotAdapters?: SnapshotAdapters;

  /** Per-aggregate snapshot retention: keep at least N snapshots */
  snapshotMinKeep?: number;

  /** Per-aggregate snapshot retention: protect last K block heights (0 => disabled) */
  snapshotKeepWindow?: number;

  [k: string]: any;
}

const INTERNAL_EVENTS = Symbol();

/**
 * Helpers for snapshot transforming specific fields
 * for exotic structures;
 * Map/Set/BigInt/Date handled automatically.
 */
export type SnapshotFieldAdapter = {
  toJSON(value: any): any;
  fromJSON(raw: any): any;
};

/** Field adapters keyed by either top-level field name OR dot-path */
export type SnapshotAdapters = Record<string, SnapshotFieldAdapter>;

/** Utility: shallow-merge adapters, instance > static */
function mergeAdapters(
  staticAdapters?: SnapshotAdapters,
  instanceAdapters?: SnapshotAdapters
): SnapshotAdapters | undefined {
  if (!staticAdapters && !instanceAdapters) return undefined;
  return { ...(staticAdapters ?? {}), ...(instanceAdapters ?? {}) };
}

/** Match either exact key or dot-path */
function matchAdapter(adapters: SnapshotAdapters | undefined, path: string, key: string) {
  if (!adapters) return undefined;
  // prefer full path match, else fall back to immediate key match
  return adapters[path] ?? adapters[key];
}

function reviveObjectDeepWithAdapters(input: any, adapters?: SnapshotAdapters): any {
  const pathStack: string[] = [];

  const walk = (value: any, key: string): any => {
    if (key) pathStack.push(key);
    const currentPath = pathStack.join('.');

    try {
      const adapter = matchAdapter(adapters, currentPath, key);
      if (adapter) return adapter.fromJSON(value);

      if (value && typeof value === 'object') {
        if ('__t' in value) {
          switch ((value as any).__t) {
            case 'Map':
              return new Map((value as any).v.map(([k, v]: [string, any]) => [k, walk(v, String(k))]));
            case 'Set':
              return new Set((value as any).v.map((v: any, i: number) => walk(v, String(i))));
            case 'Date':
              return new Date((value as any).v);
            case 'BigInt':
              return BigInt((value as any).v);
          }
        }
        if (Array.isArray(value)) {
          return value.map((v, i) => walk(v, String(i)));
        }
        const out: any = {};
        for (const k of Object.keys(value)) {
          out[k] = walk((value as any)[k], k);
        }
        return out;
      }
      return value;
    } finally {
      if (key) pathStack.pop();
    }
  };

  return walk(input, '');
}

function serializeObjectDeep(input: any, adapters?: SnapshotAdapters): any {
  const seen = new WeakSet<any>();
  const pathStack: string[] = [];

  const walk = (value: any, key: string): any => {
    if (key) pathStack.push(key);
    const currentPath = pathStack.join('.');

    try {
      const adapter = matchAdapter(adapters, currentPath, key);
      if (adapter) return adapter.toJSON(value);

      if (typeof value === 'bigint') return { __t: 'BigInt', v: value.toString() };

      if (value && typeof value === 'object') {
        if (seen.has(value)) return undefined;
        seen.add(value);

        if (value instanceof Map) {
          const arr = Array.from(value.entries()).map(([k, v]) => [k, walk(v, String(k))]);
          return { __t: 'Map', v: arr };
        }
        if (value instanceof Set) {
          const arr = Array.from(value.values()).map((v) => walk(v, ''));
          return { __t: 'Set', v: arr };
        }
        if (value instanceof Date) {
          return { __t: 'Date', v: value.toISOString() };
        }
        if (Array.isArray(value)) {
          return value.map((v, i) => walk(v, String(i)));
        }
        const out: any = {};
        for (const k of Object.keys(value)) {
          const v = walk((value as any)[k], k);
          if (v !== undefined) out[k] = v;
        }
        return out;
      }
      return value;
    } finally {
      if (key) pathStack.pop();
    }
  };

  return walk(input, '');
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
  protected _snapshotAdapters?: SnapshotAdapters;
  // Retention parameters (per-aggregate)
  private _snapshotMinKeep: number = Infinity;
  private _snapshotKeepWindow: number = 0;

  // Pruning control parameter
  private _allowPruning: boolean = false;

  constructor(aggregateId: string, lastBlockHeight: number, options?: AggregateOptions) {
    if (!aggregateId) throw new Error('aggregateId is required');
    this._aggregateId = aggregateId;
    this._lastBlockHeight = lastBlockHeight;
    this._version = 0;
    this._versionsFromSnapshot = 0;

    if (options?.snapshotsEnabled !== undefined) this._snapshotsEnabled = options.snapshotsEnabled;
    if (options?.allowPruning !== undefined) this._allowPruning = options.allowPruning;
    if (options?.snapshotInterval !== undefined) this._snapshotInterval = options.snapshotInterval;
    if (options?.snapshotAdapters !== undefined) this._snapshotAdapters = options.snapshotAdapters;
    // per-aggregate retention (optional; service defaults apply if undefined)
    if (options?.snapshotMinKeep !== undefined) this._snapshotMinKeep = options.snapshotMinKeep;
    if (options?.snapshotKeepWindow !== undefined) this._snapshotKeepWindow = options.snapshotKeepWindow;
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
  public getSnapshotRetention(): { minKeep: number; keepWindow: number } {
    return {
      minKeep: this._snapshotMinKeep,
      keepWindow: this._snapshotKeepWindow,
    };
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

  public loadFromHistory<T extends E>(history: T[]): void {
    for (const event of history) {
      this.apply(event, { fromHistory: true, skipHandler: false });
    }
  }

  public apply<T extends E>(event: T, options?: { fromHistory?: boolean; skipHandler?: boolean }): void {
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

    const mergedAdapters = mergeAdapters(
      (this.constructor as any).snapshotFieldAdapters as SnapshotAdapters | undefined,
      this._snapshotAdapters
    );

    return JSON.stringify(serializeObjectDeep(payload, mergedAdapters));
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
    // this.constructor = { name: payload.__type } as typeof Object.constructor;

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

    const mergedAdapters = mergeAdapters(
      (this.constructor as any).snapshotFieldAdapters as SnapshotAdapters | undefined,
      this._snapshotAdapters
    );

    const revived = reviveObjectDeepWithAdapters(payload, mergedAdapters);

    // First, assign all revived fields (default/adapter path)
    Object.assign(this as any, revived);
    // Then let the child fix up anything custom (partial is fine)
    this.restoreUserState(revived);
  }

  // Child may override to provide partial, field-level overrides.
  // Return only the keys you want to replace in the snapshot payload.
  // Everything else will be auto-collected & adapter-processed.
  protected serializeUserState(): Record<string, any> {
    return {};
  }

  // Child may override to fix-up cross-field invariants, rebuild prototypes,
  // run migrations, decrypt fields, etc. Default: no-op.
  protected restoreUserState(_revived: any): void {
    // no-op by default
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

  protected setEventMetadata<T extends E>(event: T): void {
    const eventName = this.getEventName(event);
    if (!Reflect.hasOwnMetadata(EVENT_METADATA, event.constructor)) {
      Reflect.defineMetadata(EVENT_METADATA, { id: eventName }, event.constructor);
    }
  }
}
