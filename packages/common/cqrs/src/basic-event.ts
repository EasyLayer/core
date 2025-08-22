import type { IEvent } from '@nestjs/cqrs';

/**
 * System fields live on the event top level.
 * User data goes into `payload`.
 */
export type SystemFields = {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  timestamp?: number;
};

/**
 * Canonical domain event envelope used everywhere.
 * `constructor.name` of the instance is the event "type".
 */
export type DomainEvent<P = any> = IEvent &
  SystemFields & {
    payload: P;
  };

export abstract class BasicEvent<P = any> implements DomainEvent<P> {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  timestamp: number;

  constructor(
    systemFields: SystemFields,
    public readonly payload: P
  ) {
    this.aggregateId = systemFields.aggregateId;
    this.requestId = systemFields.requestId;
    this.blockHeight = systemFields.blockHeight;

    // Use high-resolution time for better ordering precision
    // Convert nanoseconds to microseconds for practical precision without BigInt complexity
    this.timestamp = Number(process.hrtime.bigint() / 1000n);
  }
}
