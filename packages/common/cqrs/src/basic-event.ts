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
    this.timestamp = nowMicroseconds();
  }
}

const BOOT_EPOCH_US = BigInt(Date.now()) * 1000n - process.hrtime.bigint() / 1000n;

export function nowMicroseconds(): number {
  // <= 2^53-1 is guaranteed to be long: 1.7e15 us for the current epoch - safe for JS Number
  return Number(BOOT_EPOCH_US + process.hrtime.bigint() / 1000n);
}
