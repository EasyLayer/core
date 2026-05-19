import type { Observable, OperatorFunction } from 'rxjs';
import { EMPTY, defer, of, from, mergeMap, map, delay, throwError, retryWhen, catchError } from 'rxjs';
import type { Type } from '@nestjs/common';
import { filter } from 'rxjs/operators';
import type { DomainEvent } from './basic-event';

export interface RetryOptions {
  /** Maximum number of retry attempts after the initial attempt. Infinity keeps retrying. */
  count?: number;
  /** Base delay in milliseconds between retries; actual delay is exponential. */
  delay?: number;
  /** Upper bound for exponential delay. */
  maxDelay?: number;
  /** Add jitter up to this ratio of the computed delay. Example: 0.2 = ±20%. */
  jitterRatio?: number;
}

export interface ExecuteParams<T extends DomainEvent = DomainEvent> {
  event: Type<T>;
  command: (data: T) => Promise<void>;
}

export interface ExecuteWithRollbackParams<T extends DomainEvent = DomainEvent> {
  event: Type<T>;
  command: (data: T) => Promise<void>;
  rollback: (data: T, error?: any) => Promise<void>;
  retryOpt?: RetryOptions;
}

function normalizeRetryOptions(input?: RetryOptions | number): Required<RetryOptions> {
  if (typeof input === 'number') {
    return { count: Number.POSITIVE_INFINITY, delay: input, maxDelay: 60_000, jitterRatio: 0 };
  }
  return {
    count: input?.count ?? Number.POSITIVE_INFINITY,
    delay: input?.delay ?? 1000,
    maxDelay: input?.maxDelay ?? 60_000,
    jitterRatio: input?.jitterRatio ?? 0,
  };
}

function retryDelay(attempt: number, opts: Required<RetryOptions>): number {
  const exponential = Math.min(opts.maxDelay, Math.pow(2, attempt) * opts.delay);
  if (!opts.jitterRatio) return exponential;

  const range = exponential * opts.jitterRatio;
  return Math.max(0, Math.round(exponential - range + Math.random() * range * 2));
}

function retryStrategy(opts: Required<RetryOptions>) {
  return (errors: Observable<unknown>) =>
    errors.pipe(
      mergeMap((error, attempt) => {
        if (Number.isFinite(opts.count) && attempt >= opts.count) {
          return throwError(() => error);
        }
        return of(error).pipe(delay(retryDelay(attempt, opts)));
      })
    );
}

export function executeWithRetry<T extends DomainEvent = DomainEvent>(
  { event, command }: ExecuteParams<T>,
  retryOpt: RetryOptions | number = {}
): OperatorFunction<T, T> {
  const opts = normalizeRetryOptions(retryOpt);
  return (source: Observable<T>) =>
    source.pipe(
      ofType(event),
      mergeMap((payload) =>
        defer(() => from(command(payload))).pipe(
          map(() => payload),
          retryWhen(retryStrategy(opts))
        )
      )
    );
}

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
          // Skip means no success-like emission for the failed payload.
          // This keeps downstream operators from treating a failed command as completed work
          // and does not complete the outer event stream.
          catchError(() => EMPTY)
        )
      )
    );
}

export function executeWithRollback<T extends DomainEvent = DomainEvent>({
  event,
  command,
  rollback,
  retryOpt = {},
}: ExecuteWithRollbackParams<T>): OperatorFunction<T, T> {
  const opts = normalizeRetryOptions(retryOpt);
  return (source: Observable<T>) =>
    source.pipe(
      ofType(event),
      mergeMap((payload) =>
        defer(() => from(command(payload))).pipe(
          map(() => payload),
          catchError((error) =>
            from(rollback(payload, error)).pipe(
              retryWhen(retryStrategy(opts)),
              mergeMap(() => throwError(() => error))
            )
          )
        )
      )
    );
}

export function ofType<TInput extends DomainEvent, TOutput extends TInput>(
  ...types: Type<TOutput>[]
): (source: Observable<TInput>) => Observable<TOutput> {
  const isInstanceOf = (event: TInput): event is TOutput => {
    return types.some((classType) => {
      if (event instanceof classType) {
        return true;
      }
      return event.constructor?.name === classType.name;
    });
  };

  return (source: Observable<TInput>) => source.pipe(filter(isInstanceOf));
}
