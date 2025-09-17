import type { IEvent } from './interfaces';

/** System fields that every domain event carries. */
export type SystemFields = {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  timestamp?: number;
};

export type DomainEvent<P = any> = IEvent & SystemFields & { payload: P };

/* ---------------------- OLD (Node-only) IMPLEMENTATION ---------------------- */
// /**
//  * Last emitted timestamp in microseconds.
//  * Ensures that every new call is strictly greater than the previous one.
//  */
// let LAST_US = 0n;
//
// /**
//  * Provides a strictly monotonic, high-resolution timestamp in microseconds.
//  *
//  * Logic:
//  * - Calculate a monotonic timestamp from `process.hrtime` aligned to wall clock at boot.
//  * - Calculate wall clock microseconds from `Date.now()`.
//  * - Take the monotonic value unless it falls behind the wall clock,
//  *   in which case adjust up to `Date.now()*1000 + 1`.
//  * - Enforce strict monotonic growth between consecutive calls by comparing with LAST_US.
//  */
// export function nowMicroseconds(): number {
//   const monoUs = BOOT_EPOCH_US + process.hrtime.bigint() / 1000n; // monotonic µs since boot
//   const minUs = BigInt(Date.now()) * 1000n + 1n; // strictly greater than wall clock µs
//
//   // Use monotonic clock, but ensure it never falls behind wall clock
//   let t = monoUs < minUs ? minUs : monoUs;
//
//   // Guarantee strictly increasing sequence
//   if (t <= LAST_US) t = LAST_US + 1n;
//
//   LAST_US = t;
//   return Number(t);
// }
//
// /**
//  * Offset to align `process.hrtime` (monotonic) with wall clock at module load.
//  * This allows combining high-resolution monotonic time with real-world wall clock.
//  */
// const BOOT_EPOCH_US = BigInt(Date.now()) * 1000n - process.hrtime.bigint() / 1000n;
/* --------------------------------------------------------------------------- */

/* ---------------------- NEW (cross-runtime) IMPLEMENTATION ------------------ */

/**
 * Last emitted timestamp in microseconds (BigInt to avoid precision loss internally).
 * We convert to Number at the end with a safety check.
 */
let LAST_US: bigint = 0n;

/** Lazy init for Node fallback alignment (only if we use hrtime). */
let BOOT_EPOCH_US: bigint | null = null;

/** Try to get epoch microseconds using the browser/Node high-res clock. */
function epochMicrosFromPerformance(): bigint {
  const p: any = (globalThis as any).performance;
  if (!p || typeof p.now !== 'function' || typeof p.timeOrigin !== 'number') {
    throw new Error('High-resolution clock unavailable: performance.now/timeOrigin are required');
  }
  // Both are milliseconds; now() is monotonic with sub-ms resolution.
  const epochMs = p.timeOrigin + p.now();
  // Convert to integer microseconds via rounding.
  const us = Math.round(epochMs * 1000);
  return BigInt(us);
}

/** Fallback for Node: align hrtime to wall clock at first use and keep using it. */
function epochMicrosFromHrtime(): bigint {
  const hr = (globalThis as any)?.process?.hrtime?.bigint;
  if (typeof hr !== 'function') {
    throw new Error('process.hrtime.bigint() is not available');
  }
  if (BOOT_EPOCH_US === null) {
    // Align the monotonic counter to wall-clock epoch at the moment of first call.
    BOOT_EPOCH_US = BigInt(Date.now()) * 1000n - hr() / 1000n;
  }
  return BOOT_EPOCH_US + hr() / 1000n;
}

/** Pick the best available high-res epoch microseconds source (perf first, then hrtime). */
function epochMicrosStrict(): bigint {
  try {
    return epochMicrosFromPerformance();
  } catch {
    // If performance.* is not suitable/available, try Node hrtime fallback.
    return epochMicrosFromHrtime();
  }
}

/**
 * Provides a strictly monotonic, high-resolution timestamp in microseconds (Number).
 *
 * Logic:
 * - Prefer `performance.timeOrigin + performance.now()` (monotonic, high-res, epoch-aligned).
 * - Fallback to Node `process.hrtime.bigint()` aligned to epoch at first use.
 * - Clamp to be strictly greater than wall clock (`Date.now()*1000 + 1`).
 * - Enforce strict monotonic growth vs LAST_US.
 * - Ensure result fits into Number.MAX_SAFE_INTEGER.
 */
export function nowMicroseconds(): number {
  let t = epochMicrosStrict();

  // Must not fall behind wall clock (epoch microseconds).
  const wall = BigInt(Date.now()) * 1000n + 1n;
  if (t < wall) t = wall;

  // Strictly increasing sequence.
  if (t <= LAST_US) t = LAST_US + 1n;
  LAST_US = t;

  // Guard against exceeding JS Number safe range (unlikely until far future).
  if (t > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Timestamp exceeds Number.MAX_SAFE_INTEGER in microseconds');
  }
  return Number(t);
}
/* --------------------------------------------------------------------------- */

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
