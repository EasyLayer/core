import { Subject, Subscription } from 'rxjs';
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { DomainEvent, IMessageSource, EventBus, CustomEventBus } from '@easylayer/common/cqrs';
import { Publisher } from './publisher';

@Injectable()
export class Subscriber implements IMessageSource<DomainEvent>, OnModuleDestroy {
  private bridge!: Subject<DomainEvent>;
  private subscription!: Subscription;

  constructor(
    private readonly publisher: Publisher,
    @Inject(EventBus)
    private readonly eventBus: CustomEventBus,
    private readonly log: AppLogger
  ) {
    this.bridgeEventsTo();
    this.initialize();
  }

  onModuleDestroy() {
    if (this.subscription) {
      this.log.debug('Destroying Subscriber, unsubscribing');
      this.subscription.unsubscribe();
    }
  }

  /**
   * Set up bridge to EventBus subject
   */
  public bridgeEventsTo(): void {
    this.bridge = this.eventBus.subject$;
    this.log.debug('Bridge set to EventBus subject');
  }

  /**
   * Initialize subscription to publisher events
   */
  private initialize(): void {
    this.log.debug('Subscribing to publisher events');

    this.subscription = this.publisher.events$.subscribe((domainEvent) => {
      this.bridge.next(domainEvent);
    });
  }
}
