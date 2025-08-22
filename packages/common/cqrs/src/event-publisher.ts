import { Injectable } from '@nestjs/common';
import { CustomEventBus } from './custom-event-bus';
import type { CustomAggregateRoot } from './custom-aggregate-root';
import type { DomainEvent } from './basic-event';

export interface Constructor<T> {
  new (...args: any[]): T;
}

@Injectable()
export class EventPublisher<E extends DomainEvent = DomainEvent> {
  constructor(private eventBus: CustomEventBus<E>) {}

  mergeClassContext<T extends Constructor<CustomAggregateRoot<E>>>(
    metatype: T
  ): new (...args: ConstructorParameters<T>) => InstanceType<T> & {
    publish(event: E): Promise<void>;
    publishAll(events: E[]): Promise<void>;
  } {
    const eventBus = this.eventBus;

    return class extends metatype {
      async publish(event: E) {
        await eventBus.publish(event, this);
      }
      async publishAll(events: E[]) {
        await eventBus.publishAll(events, this);
      }
    } as any;
  }

  mergeObjectContext<T extends CustomAggregateRoot<E>>(object: T): T {
    const eventBus = this.eventBus;

    object.publish = async (event: E) => {
      await eventBus.publish(event, object);
    };
    object.publishAll = async (events: E[]) => {
      await eventBus.publishAll(events, object);
    };

    return object;
  }
}
