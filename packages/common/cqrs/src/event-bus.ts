import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, from, of, merge, Observable } from 'rxjs';
import { concatMap, catchError, filter, withLatestFrom, map, share } from 'rxjs/operators';
import type { IEvent, IEventHandler, ICommand, Type } from './interfaces';
import { EVENTS_HANDLER_METADATA, SAGA_METADATA } from './constants';

/**
 * - Publishes events to registered event handlers (matched by event constructor name).
 * - Sagas subscribe to events$ and produce commands -> sent to CommandBus.
 * - Errors thrown by event handlers are routed to UnhandledExceptionBus ONLY.
 */
@Injectable()
export class EventBus<E extends IEvent = IEvent> implements OnModuleDestroy {
  public readonly subject$ = new Subject<E>();
  private readonly _eventHandlerCompletion$ = new Subject<E>();
  private readonly _sagaCompletion$ = new Subject<E>();

  private readonly handlersByName = new Map<string, IEventHandler<E>[]>();
  private readonly sagas: Array<(events$: Observable<E>) => Observable<ICommand>> = [];
  private _commandBus?: { execute(cmd: ICommand): Promise<any> };
  private _unhandled?: { publish(exc: any): void };

  onModuleDestroy() {
    this.subject$.complete();
    this._eventHandlerCompletion$.complete();
    this._sagaCompletion$.complete();
    this.handlersByName.clear();
  }

  bindCommandBus(bus: { execute(cmd: ICommand): Promise<any> }) {
    this._commandBus = bus;
  }
  bindUnhandledBus(bus: { publish(exc: any): void }) {
    this._unhandled = bus;
  }

  get events$(): Observable<E> {
    return this.subject$.asObservable();
  }
  get eventHandlerCompletion$(): Observable<E> {
    return this._eventHandlerCompletion$.asObservable();
  }
  get sagaCompletion$(): Observable<E> {
    return this._sagaCompletion$.asObservable();
  }

  async publish(event: E): Promise<void> {
    this.subject$.next(event);
  }
  async publishAll(events: E[]): Promise<void> {
    for (const e of events) this.subject$.next(e);
  }

  registerInstances(handlers: IEventHandler<E>[]) {
    for (const h of handlers) {
      const ctor = (h as any).constructor;
      const events: Type[] = Reflect.getMetadata(EVENTS_HANDLER_METADATA, ctor) || [];
      for (const evt of events) {
        const key = evt.name;
        if (!this.handlersByName.has(key)) this.handlersByName.set(key, []);
        this.handlersByName.get(key)!.push(h);
      }
    }
    this.linkHandlers();
  }

  // registerSagaFunctions(sagas: Array<(events$: Observable<E>) => Observable<ICommand>>) {
  //   for (const s of sagas) this.sagas.push(s);
  //   this.linkSagas();
  // }

  private linkHandlers() {
    this.events$
      .pipe(
        concatMap((event: any) => {
          const key = event?.constructor?.name;
          const list = (key && this.handlersByName.get(key)) || [];
          return from(list).pipe(
            concatMap((h: any) =>
              of(h).pipe(
                concatMap(() => Promise.resolve(h.handle(event))),
                map(() => {
                  this._eventHandlerCompletion$.next(event);
                  return undefined;
                }),
                catchError((err) => {
                  this._unhandled?.publish({ cause: event, exception: err });
                  return of(undefined);
                })
              )
            )
          );
        })
      )
      .subscribe();
  }

  // private linkSagas() {
  //   if (!this.sagas.length || !this._commandBus) return;

  //   const sharedEvents$ = this.events$.pipe(share({ connector: () => new Subject(), resetOnComplete: true, resetOnError: true, resetOnRefCountZero: true }));
  //   const streams = this.sagas.map((s) =>
  //     s(sharedEvents$).pipe(
  //       withLatestFrom(sharedEvents$),
  //       map(([cmd, lastEvent]) => {
  //         this._sagaCompletion$.next(lastEvent as E);
  //         return cmd;
  //       }),
  //       catchError(() => of(undefined))
  //     )
  //   );

  //   merge(...streams)
  //     .pipe(filter((cmd: any) => !!cmd))
  //     .subscribe((cmd) => {
  //       this._commandBus!.execute(cmd);
  //     });
  // }
}
