import type { RootLoggerOptions } from '../core';
import { configureRootBunyan } from './bunyan-service';
import { getGlobalContext } from './context';
import { AppLogger } from './app-logger.service';

let bootstrapped = false;

/** Idempotent root init; safe to call multiple times. */
export function initLoggerOnce(opts?: RootLoggerOptions) {
  if (!bootstrapped) {
    configureRootBunyan(opts || {});
    bootstrapped = true;
  }
}

/** Get a component logger anywhere (inside/outside Nest). */
export function getLogger(component: string) {
  const ctx = getGlobalContext();
  return new AppLogger(ctx).child(component);
}

/** Run a function with ALS context (outside Nest). */
export function runWithContext<T>(initial: Record<string, unknown>, fn: () => T): T {
  const ctx = getGlobalContext();
  return ctx.run(initial, fn);
}
