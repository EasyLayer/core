import PQueue from 'p-queue';
import { Subject, Subscription } from 'rxjs';
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BasicEvent, EventBasePayload, IMessageSource, EventBus, CustomEventBus } from '@easylayer/common/cqrs';
import { Publisher } from './publisher';

@Injectable()
export class Subscriber implements IMessageSource<BasicEvent<EventBasePayload>>, OnModuleDestroy {
  private bridge!: Subject<BasicEvent<EventBasePayload>>;
  private subscription!: Subscription;
  // IMPORTANT: concurrency: 1 ensures that tasks will be started sequentially,
  // but does not guarantee sequential completion if the tasks are asynchronous internally.
  private queueSingleConcurrency = new PQueue({ concurrency: 1 });

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

  private initialize(): void {
    this.log.debug('Subscribing to publisher events');
    this.subscription = this.publisher.events$.subscribe((event) => {
      this.log.debug('Received event in Subscriber', { args: { event } });
      if (this.bridge) {
        this.queueSingleConcurrency.add(() => this.asyncTask(event));
      } else {
        throw new Error('Subscriber error - subject is empty');
      }
    });
  }

  bridgeEventsTo(): void {
    this.bridge = this.eventBus.subject$;
    this.log.debug('Bridge set to EventBus subject');
  }

  private asyncTask<T extends BasicEvent<EventBasePayload>>(event: T): void {
    this.log.debug('Queuing task for event', { args: { event } });
    // IMPORTANT: There may be a potential problem here
    // when the insertion error into the Read database is so fast in this particular transport
    // that the events do not have time to be stored in the EventStore.
    // They then commit, but they may simply not have time to insert into the database.
    // await new Promise((resolve) => setTimeout(resolve, 0));
    // setTimeout(() => {
    //   this.log.debug('Forwarding event to bridge', { args: { event } });
    //   this.bridge.next(event);
    // }, 0);
    this.bridge.next(event);
  }
}
