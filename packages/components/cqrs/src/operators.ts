import {
  Observable,
  OperatorFunction,
  defer,
  of,
  from,
  mergeMap,
  map,
  catchError,
  delay,
  throwError,
  retryWhen,
} from 'rxjs';
import { IEvent } from '@nestjs/cqrs';
import { Type } from '@nestjs/common';
import { filter } from 'rxjs/operators';

export interface RetryOptions {
  count?: number;
  delay?: number;
}

export interface ExecuteParams<T extends IEvent> {
  event: Type<T>;
  command: (data: T) => Promise<void>;
}

export interface ExecuteWithRollbackParams<T extends IEvent> {
  event: Type<T>;
  command: (data: T) => Promise<void>;
  rollback: (data: T, error?: any) => Promise<void>;
  retryOpt?: RetryOptions;
}

const exponentialBackoff = (attempt: number, base: number = 1000) => Math.pow(2, attempt) * base;

export function executeWithRetry<T extends IEvent>(
  { event, command }: ExecuteParams<T>,
  baseDelay: number = 1000
): OperatorFunction<T, T> {
  return (source: Observable<T>) =>
    source.pipe(
      ofType(event),
      mergeMap((payload) =>
        defer(() => from(command(payload))).pipe(
          map(() => payload),
          catchError((error) => {
            return throwError(() => error); // Ensure error is passed down for retry
          }),
          retryWhen((errors) =>
            errors.pipe(
              mergeMap((error, attempt) => {
                if (attempt >= Infinity) {
                  // Handle case when retries exceed the limit
                  return throwError(() => new Error('Retry limit exceeded'));
                }
                return of(error).pipe(delay(exponentialBackoff(attempt, baseDelay)));
              })
            )
          )
        )
      )
    );
}

export function executeWithSkip<T extends IEvent>({ event, command }: ExecuteParams<T>): OperatorFunction<T, T> {
  return (source: Observable<T>) =>
    source.pipe(
      ofType(event),
      mergeMap((payload) =>
        defer(() => from(command(payload))).pipe(
          map(() => payload),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          catchError((error) => {
            return of(payload); // Skip error
          })
        )
      )
    );
}

export function executeWithRollback<T extends IEvent>({
  event,
  command,
  rollback,
  retryOpt = {},
}: ExecuteWithRollbackParams<T>): OperatorFunction<T, T> {
  return (source: Observable<T>) =>
    source.pipe(
      ofType(event),
      mergeMap((payload) =>
        defer(() => from(command(payload))).pipe(
          catchError((error) =>
            from(rollback(payload, error)).pipe(
              retryWhen((errors) =>
                errors.pipe(
                  mergeMap((error, attempt) => {
                    if (attempt >= (retryOpt.count ?? Infinity)) {
                      // Handle case when retries exceed the limit
                      return throwError(() => new Error('Retry limit exceeded'));
                    }
                    return of(error).pipe(delay(exponentialBackoff(attempt, retryOpt.delay)));
                  })
                )
              )
            )
          ),
          map(() => payload)
        )
      )
    );
}

export function ofType<TInput extends IEvent, TOutput extends TInput>(
  ...types: Type<TOutput>[]
): (source: Observable<TInput>) => Observable<TOutput> {
  const isInstanceOf = (event: TInput): event is TOutput => {
    return types.some((classType) => {
      // Checking if event is an instance of a class
      if (event instanceof classType) {
        return true;
      }
      // Checking if event has a constructor.name field corresponding to the class name
      return event.constructor?.name === classType.name;
    });
  };

  return (source: Observable<TInput>) => source.pipe(filter(isInstanceOf));
}
