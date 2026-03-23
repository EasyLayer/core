import type { RootLoggerOptions, IAppLogger } from '../core';
import { AppLogger, configureRootConsole } from './app-logger.service';
import { getGlobalContext } from './context';

let bootstrapOpts: RootLoggerOptions | null = null;
let bootstrapped = false;

/** Idempotent root init; safe to call multiple times. */
export function initLoggerOnce(opts: RootLoggerOptions) {
  if (!bootstrapped) {
    configureRootConsole(opts);
    bootstrapOpts = opts;
    bootstrapped = true;
  }
}

/** Run a function with context (outside Nest). Browser uses sync stack-based ALS. */
export function runWithContext<T>(initial: Record<string, unknown>, fn: () => T): T {
  const ctx = getGlobalContext();
  return ctx.run(initial, fn);
}

/**
 * Returns a bootstrap-phase logger backed by browser console.
 * API-compatible with the Node version (getBootstrapLogger from node/bootstrap.ts),
 * so consumers like eventstore.browser.module.ts import from @easylayer/common/logger
 * and get the correct implementation per environment.
 */
export function getBootstrapLogger(component?: string): IAppLogger {
  // Ensure the root console is configured at least once with trace-level defaults
  // so bootstrap-phase logs are visible even before initLoggerOnce() is called.
  if (!bootstrapped) {
    configureRootConsole({
      name: 'bootstrap',
      level: 'trace',
      enabled: true,
    });
  }

  // Browser AppLogger reads from the global ConsoleRoot singleton set by configureRootConsole.
  // Constructor only takes optional ContextService — opts come from the global state.
  const logger = new AppLogger(getGlobalContext());
  return component ? logger.child(component) : logger;
}
