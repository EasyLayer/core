import type { RootLoggerOptions } from '../core';
import { configureRootBunyan } from './bunyan-service';
import { getGlobalContext } from './context';

let bootstrapped = false;

/** Idempotent root init; safe to call multiple times. */
export function initLoggerOnce(opts: RootLoggerOptions) {
  if (!bootstrapped) {
    configureRootBunyan(opts);
    bootstrapped = true;
  }
}

/** Run a function with ALS context (outside Nest). */
export function runWithContext<T>(initial: Record<string, unknown>, fn: () => T): T {
  const ctx = getGlobalContext();
  return ctx.run(initial, fn);
}
