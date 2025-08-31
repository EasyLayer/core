import type { IEvent } from '@nestjs/cqrs';

export type SystemFields = {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  timestamp?: number;
};

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

    // Assign a strictly-monotonic high-resolution timestamp in microseconds
    this.timestamp = nowMicroseconds();
  }
}

/**
 * Last emitted timestamp in microseconds.
 * Ensures that every new call is strictly greater than the previous one.
 */
let LAST_US = 0n;

/**
 * Provides a strictly monotonic, high-resolution timestamp in microseconds.
 *
 * Logic:
 * - Calculate a monotonic timestamp from `process.hrtime` aligned to wall clock at boot.
 * - Calculate wall clock microseconds from `Date.now()`.
 * - Take the monotonic value unless it falls behind the wall clock,
 *   in which case adjust up to `Date.now()*1000 + 1`.
 * - Enforce strict monotonic growth between consecutive calls by comparing with LAST_US.
 */
export function nowMicroseconds(): number {
  const monoUs = BOOT_EPOCH_US + process.hrtime.bigint() / 1000n; // monotonic µs since boot
  const minUs = BigInt(Date.now()) * 1000n + 1n; // strictly greater than wall clock µs

  // Use monotonic clock, but ensure it never falls behind wall clock
  let t = monoUs < minUs ? minUs : monoUs;

  // Guarantee strictly increasing sequence
  if (t <= LAST_US) t = LAST_US + 1n;

  LAST_US = t;
  return Number(t);
}

/**
 * Offset to align `process.hrtime` (monotonic) with wall clock at module load.
 * This allows combining high-resolution monotonic time with real-world wall clock.
 */
const BOOT_EPOCH_US = BigInt(Date.now()) * 1000n - process.hrtime.bigint() / 1000n;
