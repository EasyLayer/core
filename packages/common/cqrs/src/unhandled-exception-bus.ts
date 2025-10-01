import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * - Used ONLY for event-handler errors (fire-and-forget).
 * - Commands/Queries propagate errors to caller and are NOT published here.
 */
@Injectable()
export class UnhandledExceptionBus {
  private readonly subject$ = new Subject<any>();
  publish(exc: any) {
    this.subject$.next(exc);
  }
  get stream$() {
    return this.subject$.asObservable();
  }
}
