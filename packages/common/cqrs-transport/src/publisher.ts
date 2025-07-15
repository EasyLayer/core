import { Injectable, Inject } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BasicEvent, EventBasePayload, IEventPublisher, isSystemEvent } from '@easylayer/common/cqrs';
import { ProducersManager } from '@easylayer/common/network-transport';
import { Subject } from 'rxjs';

@Injectable()
export class Publisher implements IEventPublisher<BasicEvent<EventBasePayload>> {
  private subject$ = new Subject<BasicEvent<EventBasePayload>>();

  constructor(
    @Inject(ProducersManager)
    private readonly producersManager: ProducersManager,
    private readonly log: AppLogger
  ) {}

  get events$() {
    return this.subject$.asObservable();
  }

  async publish<T extends BasicEvent<EventBasePayload>>(event: T): Promise<void> {
    this.log.debug('Publishing single event', { args: { event } });
    // IMPORTANT: don't need catch here,
    // if some event makes a mistake, the commit method will roll back
    await this.producersManager.broadcast([event]);

    this.log.debug('Broadcast to external transport succeeded');

    // IMPORTANT: publish to local transport AFTER success publishing ti external transport
    // IMPORTANT: We publish to local handlers and custom events - this is for cases when users extend the functionality with their own handlers
    // if (isSystemEvent(event)) {
    await this.publishToLocalTransport(event);
    // }
  }

  async publishAll<T extends BasicEvent<EventBasePayload>>(events: T[]): Promise<void> {
    this.log.debug('Publishing batch of events', { args: { count: events.length } });
    // const systemEvents: T[] = events.filter(isSystemEvent);

    // IMPORTANT: don't need catch here,
    // if some event makes a mistake, the commit method will roll back
    await this.producersManager.broadcast(events);
    this.log.debug('Broadcast to external transport succeeded for batch', { args: { count: events.length } });

    // IMPORTANT: publish to local transport AFTER success publishing ti external transport
    // We publish to local handlers and custom events - this is for cases when users extend the functionality with their own handlers
    for (const event of events) {
      //systemEvents
      await this.publishToLocalTransport(event);
    }
  }

  private async publishToLocalTransport<T extends BasicEvent<EventBasePayload>>(event: T): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.log.debug('Publishing system event to local transport', { args: { event } });
    // Sending an event to subscribers
    this.subject$.next(event);
  }
}
