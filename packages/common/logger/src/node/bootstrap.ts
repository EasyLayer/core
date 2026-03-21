import type { RootLoggerOptions, IAppLogger } from '../core';
import { AppLogger } from './app-logger.service';
import { configureRootBunyan } from './bunyan-service';
import { getGlobalContext } from './context';

let bootstrapOpts: RootLoggerOptions | null = null;

let bootstrapped = false;

/** Idempotent root init; safe to call multiple times. */
export function initLoggerOnce(opts: RootLoggerOptions) {
  if (!bootstrapped) {
    configureRootBunyan(opts);
    bootstrapOpts = opts;
    bootstrapped = true;
  }
}

/** Run a function with ALS context (outside Nest). */
export function runWithContext<T>(initial: Record<string, unknown>, fn: () => T): T {
  const ctx = getGlobalContext();
  return ctx.run(initial, fn);
}

export function getBootstrapLogger(component?: string): IAppLogger {
  const opts = bootstrapOpts ?? {
    name: 'bootstrap',
    level: 'trace',
    enabled: true,
  };

  const logger = new AppLogger(getGlobalContext(), opts);
  return component ? logger.child(component) : logger;
}
