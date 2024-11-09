import PQueue from 'p-queue';
import { Subject, Subscription } from 'rxjs';
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { IEvent, IMessageSource, EventBus, CustomEventBus } from '@easylayer/components/cqrs';
import { Publisher } from './publisher';

@Injectable()
export class Subscriber implements IMessageSource, OnModuleDestroy {
  private bridge!: Subject<IEvent>;
  private subscription!: Subscription;
  // IMPORTANT: concurrency: 1 ensures that tasks will be started sequentially,
  // but does not guarantee sequential completion if the tasks are asynchronous internally.
  private queueSingleConcurrency = new PQueue({ concurrency: 1 });

  constructor(
    private readonly publisher: Publisher,
    @Inject(EventBus)
    private readonly eventBus: CustomEventBus
  ) {
    this.bridgeEventsTo();
    this.initialize();
  }

  onModuleDestroy() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  private initialize(): void {
    this.subscription = this.publisher.events$.subscribe((event) => {
      if (this.bridge) {
        this.queueSingleConcurrency.add(() => this.asyncTask(event));
      } else {
        throw new Error('Subscriber error - subject is empty');
      }
    });
  }

  bridgeEventsTo(): void {
    this.bridge = this.eventBus.subject$;
  }

  private async asyncTask<T extends IEvent>(event: T): Promise<void> {
    // IMPORTANT: There may be a potential problem here
    // when the insertion error into the Read database is so fast in this particular transport
    // that the events do not have time to be stored in the EventStore.
    // They then commit, but they may simply not have time to insert into the database.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.bridge.next(event);
  }
}
