import type { Subscription } from 'rxjs';
import type { Logger } from '@nestjs/common';
import type { DomainEvent, EventBus } from '@easylayer/common/cqrs';
import type { Publisher } from './publisher';

export class Subscriber {
  private subscription?: Subscription;

  constructor(
    private readonly publisher: Publisher,
    private readonly eventBus: EventBus,
    private readonly log: Logger
  ) {
    this.initialize();
  }

  destroy() {
    if (this.subscription) {
      this.log.verbose('Destroying Subscriber, unsubscribing');
      this.subscription.unsubscribe();
    }
  }

  private initialize(): void {
    this.log.verbose('Subscribing to publisher events');
    this.subscription = this.publisher.events$.subscribe((domainEvent: DomainEvent) => {
      this.eventBus.subject$.next(domainEvent);
    });
  }
}
