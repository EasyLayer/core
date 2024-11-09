import { Injectable } from '@nestjs/common';
import { IEvent, IEventPublisher } from '@easylayer/components/cqrs';
import { Subject } from 'rxjs';
import PQueue from 'p-queue';

@Injectable()
export class Publisher implements IEventPublisher {
  private subject$ = new Subject<IEvent>();
  private queue = new PQueue({ concurrency: 1 });

  get events$() {
    return this.subject$.asObservable();
  }

  async publish<T extends IEvent>(event: T): Promise<void> {
    // IMPORTANT: we don't use await before this.queue.add()
    // because want to method inside .add() finished asynchronous.
    // The same before this.asyncTask()
    this.queue
      .add(() => this.asyncTask(event))
      .catch((error) => {
        // IMPORTANT: This error will cause the transaction to be rolled back.
        // NOTE: In theory we will never get here
        throw error;
      });
  }

  async publishAll<T extends IEvent>(events: T[]): Promise<void> {
    for (const event of events) {
      // IMPORTANT: we don't use await before this.queue.add()
      // because want to method inside .add() finished asynchronous.
      // The same before this.asyncTask()
      this.queue
        .add(() => this.asyncTask(event))
        .catch((error) => {
          // IMPORTANT: This error will cause the transaction to be rolled back.
          // NOTE: In theory we will never get here
          throw error;
        });
    }
  }

  private async asyncTask<T extends IEvent>(event: T): Promise<void> {
    // IMPORTANT: This is necessary so that in cases of an asynchronous error,
    // all functions (for example, committing aggregate) must be completed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Sending an event to subscribers
    this.subject$.next(event);
  }
}
