import { AsyncLocalStorage } from 'node:async_hooks';
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

export class ContextService {
  private readonly als = new AsyncLocalStorage<ContextData>();

  run<T>(initial: ContextData, fn: () => T): T {
    return this.als.run(initial, fn);
  }

  get<T = any>(key: keyof ContextData): T | undefined {
    const store = this.als.getStore();
    return store ? (store[key] as T) : undefined;
  }

  set(key: keyof ContextData, value: any): void {
    const store = this.als.getStore();
    if (store) store[key] = value;
  }

  remove(key: keyof ContextData): void {
    const store = this.als.getStore();
    if (store && key in store) delete store[key];
  }

  bind<T extends (...args: any[]) => any>(fn: T): T {
    const store = this.als.getStore();
    if (!store) return fn;
    const bound = (...args: any[]) => this.als.run(store, () => fn(...args));
    return bound as T;
  }

  init(requestId: string, type: ContextData['type']): void {
    this.als.enterWith({ requestId, type });
  }
}
