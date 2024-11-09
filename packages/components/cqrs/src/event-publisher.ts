import { Injectable } from '@nestjs/common';
import { IEvent } from '@nestjs/cqrs';
import { CustomEventBus } from './custom-event-bus';
import { CustomAggregateRoot } from './custom-aggregate-root';

export interface Constructor<T> {
  new (...args: any[]): T;
}

@Injectable()
export class EventPublisher<EventBase extends IEvent = IEvent> {
  constructor(private eventBus: CustomEventBus<EventBase>) {}

  mergeClassContext<T extends Constructor<CustomAggregateRoot<EventBase>>>(metatype: T): T {
    const eventBus = this.eventBus;

    return class extends metatype {
      publish = async (event: EventBase) => {
        await eventBus.publish(event, this);
      };

      publishAll = async (events: EventBase[]) => {
        await eventBus.publishAll(events, this);
      };
    };
  }

  mergeObjectContext<T extends CustomAggregateRoot<EventBase>>(object: T): T {
    const eventBus = this.eventBus;

    object.publish = async (event: EventBase) => {
      await eventBus.publish(event, object);
    };

    object.publishAll = async (events: EventBase[]) => {
      await eventBus.publishAll(events, object);
    };

    return object;
  }
}
