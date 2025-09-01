import { v4 as uuidv4 } from 'uuid';
import { AggregateRoot, type AggregateOptions } from '@easylayer/common/cqrs';
import type { ExecutionContext } from './types';
import { makeNamedEventCtor } from './event';

/** Class-based model constructor */
export type ModelCtor<T extends Model = Model> = new (
  aggregateId: string,
  lastBlockHeight: number,
  override?: { options?: any }
) => T;

export abstract class Model extends AggregateRoot {
  // Internal flag: true only while rehydrating from event history.
  // Used to allow AggregateRoot.loadFromHistory() to call `apply()`
  // without hitting our runtime guard.
  private _rehydrating = false;

  /**
   * Rehydrate this aggregate from historical events.
   *
   * Override here only to set a guard flag:
   * - While rehydrating, calls to `this.apply(event)` are allowed
   *   (AggregateRoot.loadFromHistory internally calls `this.apply`).
   * - Outside of rehydration, direct `apply(event)` is forbidden.
   */
  public override loadFromHistory(events: any[]): void {
    this._rehydrating = true;
    try {
      // Delegates to AggregateRoot implementation, which will call `this.apply(event)`
      super.loadFromHistory(events);
    } finally {
      this._rehydrating = false;
    }
  }

  /**
   * Override of `apply(event)` from AggregateRoot.
   *
   * We explicitly forbid users of this class from calling `apply(event)` directly,
   * to enforce usage of `applyEvent(name, payload)` instead.
   *
   * The only exception: when `_rehydrating = true` (inside loadFromHistory),
   * we delegate back to the base class to replay past events.
   */
  public override apply(event: any, options?: { fromHistory?: boolean; skipHandler?: boolean }): void {
    if (this._rehydrating) {
      // Allowed during history replay → delegate to real AggregateRoot.apply
      super.apply(event, options);
      return;
    }
    // Outside of rehydration → block direct usage
    throw new Error('Direct apply(event) is forbidden. Use applyEvent(name, payload).');
  }

  /**
   * The *only* intended entry point for emitting new domain events.
   *
   * Users call `applyEvent(eventName, payload)`:
   * - A proper Event constructor is resolved by name.
   * - Metadata (aggregateId, requestId, blockHeight) is automatically added.
   * - The constructed event is sent directly to the AggregateRoot via `super.apply`.
   *
   * This enforces a consistent way of creating events and hides low-level details.
   */
  protected applyEvent(eventName: string, blockHeight: number, payload?: any): void {
    const EventCtor = makeNamedEventCtor(eventName);
    const ev = new EventCtor(
      {
        aggregateId: this.aggregateId,
        requestId: uuidv4(),
        blockHeight,
      },
      payload
    );
    // Note: we call super.apply(ev) directly to bypass our override guard,
    // because this is the officially allowed path to create new events.
    super.apply(ev);
  }

  /**
   * Each derived model must implement this method to process a blockchain block.
   * This is where business logic for parsing, normalizing and emitting events lives.
   */
  public abstract processBlock(ctx: ExecutionContext): Promise<void>;
}
