import { BrowserALS } from './browser-als';
import type { ContextData } from '../../core';

let sharedCtx: ContextService | null = null;

/** Get the single, process-wide ContextService instance. */
export function getGlobalContext(): ContextService {
  if (!sharedCtx) sharedCtx = new ContextService();
  return sharedCtx;
}

/** (Optional) Replace the global instance (e.g., for tests). */
export function setGlobalContext(ctx: ContextService) {
  sharedCtx = ctx;
}

/**
 * Browser implementation backed by a tiny ALS.
 */
export class ContextService {
  private readonly als: BrowserALS<ContextData>;

  constructor() {
    // Single instance on window for safety across bundles.
    const w = window as any;
    if (!w.__loggerCtxALS) w.__loggerCtxALS = new BrowserALS<ContextData>();
    this.als = w.__loggerCtxALS as BrowserALS<ContextData>;
  }

  run<T>(initial: ContextData, fn: () => T): T {
    return this.als.run(initial, fn);
  }

  get<T = any>(key: keyof ContextData): T | undefined {
    const s = this.als.getStore();
    return s ? (s[key] as T) : undefined;
  }

  set(key: keyof ContextData, value: any): void {
    const s = this.als.getStore();
    if (s) s[key] = value;
  }

  remove(key: keyof ContextData): void {
    const s = this.als.getStore();
    if (s && key in s) delete s[key];
  }

  bind<T extends (...args: any[]) => any>(fn: T): T {
    return this.als.bind(fn);
  }

  init(requestId: string, type: ContextData['type']): void {
    this.als.enterWith({ requestId, type });
  }
}
