import type { Observable, OperatorFunction } from 'rxjs';
import { defer, of, from, mergeMap, map, catchError, delay, throwError, retryWhen } from 'rxjs';
import type { Type } from '@nestjs/common';
import { filter } from 'rxjs/operators';
import type { DomainEvent } from './basic-event';

/**
 * Configuration options for retry behavior.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts.
   */
  count?: number;
  /**
   * Base delay in milliseconds between retries; actual delay is exponential.
   */
  delay?: number;
}

/**
 * Parameters for executing a command when an event is received, with retry logic only.
 * @template T The event type.
 */
export interface ExecuteParams<T extends DomainEvent = DomainEvent> {
  /**
   * The event class to filter for.
   */
  event: Type<T>;
  /**
   * Asynchronous command to invoke when the event is received.
   */
  command: (data: T) => Promise<void>;
}

/**
 * Parameters for executing a command with rollback and optional retry when an event is received.
 * @template T The event type.
 */
export interface ExecuteWithRollbackParams<T extends DomainEvent = DomainEvent> {
  /**
   * The event class to filter for.
   */
  event: Type<T>;
  /**
   * Asynchronous command to invoke when the event is received.
   */
  command: (data: T) => Promise<void>;
  /**
   * Asynchronous rollback function to invoke if the command fails.
   */
  rollback: (data: T, error?: any) => Promise<void>;
  /**
   * Optional retry configuration for the rollback operation.
   */
  retryOpt?: RetryOptions;
}

/**
 * Compute exponential backoff delay for retry attempts.
 * @param attempt Zero-based retry attempt index.
 * @param base Base delay in ms. Defaults to 1000.
 * @returns Milliseconds to wait before next retry.
 */
const exponentialBackoff = (attempt: number, base: number = 1000) => Math.pow(2, attempt) * base;

/**
 * Operator that filters an Observable to events of the specified class,
 * executes a command with infinite retries and exponential backoff,
 * and re-emits the original payload on success.
 * @param params Event and command configuration.
 * @param baseDelay Optional base delay for exponential backoff.
 * @returns An RxJS operator function.
 */
export function executeWithRetry<T extends DomainEvent = DomainEvent>(
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

/**
 * Operator that filters an Observable to events of the specified class,
 * executes a command once, and on error silently skips the event.
 * @param params Event and command configuration.
 * @returns An RxJS operator function.
 */
export function executeWithSkip<T extends DomainEvent = DomainEvent>({
  event,
  command,
}: ExecuteParams<T>): OperatorFunction<T, T> {
  return (source: Observable<T>) =>
    source.pipe(
      ofType(event),
      mergeMap((payload) =>
        defer(() => from(command(payload))).pipe(
          map(() => payload),

          catchError((error) => {
            return of(payload); // Skip error
          })
        )
      )
    );
}

/**
 * Operator that filters an Observable to events of the specified class,
 * executes a command, and upon failure runs a rollback function with retry logic,
 * then re-emits the original payload on success.
 * @param params Event, command, rollback, and retry configuration.
 * @returns An RxJS operator function.
 */
export function executeWithRollback<T extends DomainEvent = DomainEvent>({
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

/**
 * Type guard operator that filters an Observable of events,
 * passing through only those instances matching the provided classes.
 * @param types One or more event classes to filter.
 * @returns An RxJS operator function narrowing the stream.
 */
export function ofType<TInput extends DomainEvent, TOutput extends TInput>(
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
