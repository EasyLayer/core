import type { Subscription } from 'rxjs';
import type { Logger } from '@nestjs/common';
import type { EventBus } from '@easylayer/common/cqrs';
import type { Publisher } from './publisher';

export class Subscriber {
  private readonly moduleName = 'cqrs-transport';
  private subscription?: Subscription;

  constructor(
    private readonly publisher: Publisher,
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {
    this.initialize();
  }

  destroy() {
    if (this.subscription) {
      this.logger.verbose('Destroying subscriber', {
        module: this.moduleName,
      });
      this.subscription.unsubscribe();
    }
  }

  private initialize(): void {
    this.logger.verbose('Subscribing to publisher events', {
      module: this.moduleName,
    });
    this.subscription = this.publisher.events$.subscribe((domainEvent) => {
      this.eventBus.publish(domainEvent);
    });
  }
}
