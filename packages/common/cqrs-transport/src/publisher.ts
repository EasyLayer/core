import { Injectable, Inject } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { DomainEvent, IEventPublisher, isSystemEvent } from '@easylayer/common/cqrs';
import { ProducersManager } from '@easylayer/common/network-transport';
import { Subject } from 'rxjs';

@Injectable()
export class Publisher implements IEventPublisher<DomainEvent> {
  private subject$ = new Subject<DomainEvent>();

  constructor(
    @Inject(ProducersManager)
    private readonly producersManager: ProducersManager,
    private readonly log: AppLogger
  ) {}

  get events$() {
    return this.subject$.asObservable();
  }

  async publish<T extends DomainEvent>(event: T): Promise<void> {
    this.log.debug('Publishing single event', { args: { event } });
    // IMPORTANT: don't need catch here,
    // if some event makes a mistake, the commit method will roll back
    await this.producersManager.broadcast([event]);

    this.log.debug('Broadcast to external transport succeeded');

    // IMPORTANT: publish to local transport AFTER success publishing ti external transport
    // IMPORTANT: We publish to local handlers and custom events - this is for cases when users extend the functionality with their own handlers
    // if (isSystemEvent(event)) {
    await this.publishToLocalTransport([event]);
    // }
  }

  async publishAll<T extends DomainEvent>(events: T[]): Promise<void> {
    this.log.debug('Publishing batch of events', { args: { count: events.length } });
    // const systemEvents: T[] = events.filter(isSystemEvent);

    // IMPORTANT: don't need catch here,
    // if some event makes a mistake, the commit method will roll back
    await this.producersManager.broadcast(events);
    this.log.debug('Broadcast to external transport succeeded for batch', { args: { count: events.length } });

    // IMPORTANT: publish to local transport AFTER success publishing ti external transport
    // IMPORTANT: We publish to local handlers users events as well - this is for cases when users extend the functionality with their own handlers
    await this.publishToLocalTransport(events);
  }

  private async publishToLocalTransport<T extends DomainEvent>(events: T[]): Promise<void> {
    // IMPORTANT: We use setTimeout(0) once for entire events batch
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const event of events) {
      // Sending an event to subscribers
      this.subject$.next(event);
    }
  }
}
