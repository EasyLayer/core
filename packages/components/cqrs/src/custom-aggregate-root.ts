import { Type } from '@nestjs/common';
import { IEvent, IEventHandler } from '@nestjs/cqrs';
import { EVENT_METADATA } from '@nestjs/cqrs/dist/decorators/constants';

const INTERNAL_EVENTS = Symbol();
const IS_AUTO_COMMIT_ENABLED = Symbol();

export abstract class CustomAggregateRoot<EventBase extends IEvent = IEvent> {
  public [IS_AUTO_COMMIT_ENABLED] = false;
  private readonly [INTERNAL_EVENTS]: EventBase[] = [];
  protected _version: number = 0;

  set autoCommit(value: boolean) {
    this[IS_AUTO_COMMIT_ENABLED] = value;
  }

  get autoCommit(): boolean {
    return this[IS_AUTO_COMMIT_ENABLED];
  }

  get version(): number {
    return this._version;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async publish<T extends EventBase = EventBase>(event: T): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async publishAll<T extends EventBase = EventBase>(event: T[]): Promise<void> {}

  /**
   * Publishes an event.
   * This method sets the event metadata before publishing it.
   *
   * @param event The event to be published.
   */
  public async republish<T extends EventBase = EventBase>(event: T): Promise<void> {
    this.setEventMetadata(event);
    await this.publish(event);
  }

  public async commit(): Promise<void> {
    const events = this.getUncommittedEvents();
    await this.publishAll(events);
    this.uncommit();
  }

  public async loadFromHistory(history: EventBase[]): Promise<void> {
    for (const event of history) {
      await this.apply(event, true);
    }
  }

  public async apply<T extends EventBase = EventBase>(
    event: T,
    optionsOrIsFromHistory?:
      | boolean
      | {
          fromHistory?: boolean;
          skipHandler?: boolean;
        }
  ): Promise<void> {
    let isFromHistory = false;
    let skipHandler = false;

    if (typeof optionsOrIsFromHistory === 'boolean') {
      isFromHistory = optionsOrIsFromHistory;
    } else if (typeof optionsOrIsFromHistory === 'object') {
      isFromHistory = optionsOrIsFromHistory.fromHistory ?? false;
      skipHandler = optionsOrIsFromHistory.skipHandler ?? false;
    }

    if (!isFromHistory && !this.autoCommit) {
      // Because of this we had to rewrite the entire aggregate class
      this[INTERNAL_EVENTS].push(event);
    }

    if (!skipHandler) {
      const handler = this.getEventHandler(event);
      if (handler) {
        await handler.call(this, event);
      }
    }

    if (this.autoCommit) {
      // When autoCommit is set to true,
      // it means that any event applied to the aggregate should be published immediately.
      // This is useful in scenarios where you want changes to an aggregate
      // to immediately cause events to be published, without having to manually call commit.
      await this.publish(event);
    }

    // increment version for each event
    this._version++;
  }

  public uncommit() {
    this[INTERNAL_EVENTS].length = 0;
  }

  public getUncommittedEvents(): EventBase[] {
    return this[INTERNAL_EVENTS];
  }

  public toSnapshotPayload(): string {
    const payload: any = {
      __type: this.constructor.name,
      ...this.toJsonPayload(),
      version: this._version,
    };
    return JSON.stringify(payload, this.getCircularReplacer());
  }

  public loadFromSnapshot({ payload }: any): void {
    const deserializedPayload = JSON.parse(payload);

    this.constructor = { name: deserializedPayload.__type } as typeof Object.constructor;

    if (deserializedPayload.version !== undefined) {
      this._version = deserializedPayload.version;
    }

    // IMPORTANT: We don't need to restore the prototype and properties since loadFromSnapshot() is not a static method,
    // but a method inside an instance of the base aggregate.
    // const instance = Object.create(CustomAggregateRoot.prototype);
    // Object.assign(this, instance);

    this.fromSnapshot(deserializedPayload);
  }

  protected toJsonPayload(): any {
    return {};
  }

  // IMPORTANT: When an aggregate inherits from CustomAggregateRoot
  // and has complex structures in its properties, for the restoration of which a prototype is required,
  // then this fromSnapshot method must be overridden in the aggregate itself,
  // since it has access to the classes of its structures.
  protected fromSnapshot(state: any): void {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { version, ...rest } = state;
    Object.assign(this, rest);
  }

  protected getEventHandler<T extends EventBase = EventBase>(event: T): Type<IEventHandler> | undefined {
    const handler = `on${this.getEventName(event)}`;
    // eslint-disable-next-line
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
  protected setEventMetadata(event: EventBase): void {
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
