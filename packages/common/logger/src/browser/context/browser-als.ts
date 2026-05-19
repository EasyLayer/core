type Fn = (...args: any[]) => any;

const ALS_KEY = Symbol.for('slogger.browserALS');
const PATCHED_KEY = Symbol.for('easylayer.logger.browserALS.patched');

function runtime(): any {
  if (typeof globalThis === 'undefined') return undefined;
  return globalThis as any;
}

function listenerKey(type: string, options?: AddEventListenerOptions | boolean): string {
  const capture = typeof options === 'boolean' ? options : !!options?.capture;
  return `${type}:${capture ? 'capture' : 'bubble'}`;
}

export class BrowserALS<T extends object> {
  private store: T | undefined;
  private readonly listenerMap = new WeakMap<
    EventListenerOrEventListenerObject,
    Map<string, EventListenerOrEventListenerObject>
  >();

  run<R>(initial: T, fn: () => R): R {
    const prev = this.store;
    this.store = initial;
    try {
      return fn();
    } finally {
      this.store = prev;
    }
  }

  enterWith(value: T): void {
    this.store = value;
  }

  getStore(): T | undefined {
    return this.store;
  }

  bind<F extends Fn>(fn: F): F {
    const captured = this.store;
    const wrapped = ((...args: any[]) => {
      const prev = this.store;
      this.store = captured;
      try {
        return fn(...args);
      } finally {
        this.store = prev;
      }
    }) as F;
    return wrapped;
  }

  private getOrCreateWrappedListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): EventListenerOrEventListenerObject {
    const key = listenerKey(type, options);
    let byKey = this.listenerMap.get(listener);
    if (!byKey) {
      byKey = new Map();
      this.listenerMap.set(listener, byKey);
    }

    const existing = byKey.get(key);
    if (existing) return existing;

    let wrapped: EventListenerOrEventListenerObject;
    if (typeof listener === 'function') {
      wrapped = this.bind(listener as EventListener);
    } else {
      wrapped = {
        handleEvent: this.bind(listener.handleEvent.bind(listener)),
      };
    }

    byKey.set(key, wrapped);
    return wrapped;
  }

  private takeWrappedListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): EventListenerOrEventListenerObject | undefined {
    const key = listenerKey(type, options);
    const byKey = this.listenerMap.get(listener);
    const wrapped = byKey?.get(key);
    byKey?.delete(key);
    if (byKey && byKey.size === 0) this.listenerMap.delete(listener);
    return wrapped;
  }

  patch(): void {
    const g = runtime();
    if (!g || g[PATCHED_KEY]) return;
    g[PATCHED_KEY] = true;

    const getAls = () => getGlobalBrowserALS<T>();

    const originalThen = Promise.prototype.then;
    // @ts-ignore - preserve native Promise signature while wrapping callbacks.
    Promise.prototype.then = function (onFulfilled?: Fn, onRejected?: Fn) {
      const als = getAls();
      const fulfilled = onFulfilled ? als.bind(onFulfilled) : undefined;
      const rejected = onRejected ? als.bind(onRejected) : undefined;
      return originalThen.call(this, fulfilled, rejected);
    };

    const originalQueueMicrotask = g.queueMicrotask?.bind(g);
    if (originalQueueMicrotask) {
      g.queueMicrotask = ((cb: Fn) => originalQueueMicrotask(getAls().bind(cb))) as typeof globalThis.queueMicrotask;
    }

    const originalSetTimeout = g.setTimeout?.bind(g);
    if (originalSetTimeout) {
      g.setTimeout = ((cb: Fn, ms?: number, ...rest: any[]) =>
        originalSetTimeout(getAls().bind(cb), ms, ...rest)) as typeof globalThis.setTimeout;
    }

    const originalSetInterval = g.setInterval?.bind(g);
    if (originalSetInterval) {
      g.setInterval = ((cb: Fn, ms?: number, ...rest: any[]) =>
        originalSetInterval(getAls().bind(cb), ms, ...rest)) as typeof globalThis.setInterval;
    }

    const EventTargetCtor = g.EventTarget;
    if (EventTargetCtor?.prototype?.addEventListener && EventTargetCtor?.prototype?.removeEventListener) {
      const originalAdd = EventTargetCtor.prototype.addEventListener;
      const originalRemove = EventTargetCtor.prototype.removeEventListener;

      EventTargetCtor.prototype.addEventListener = function (type: string, listener: any, options?: any) {
        if (listener && (typeof listener === 'function' || typeof listener.handleEvent === 'function')) {
          const wrapped = getAls().getOrCreateWrappedListener(type, listener, options);
          return originalAdd.call(this, type, wrapped, options);
        }

        return originalAdd.call(this, type, listener, options);
      };

      EventTargetCtor.prototype.removeEventListener = function (type: string, listener: any, options?: any) {
        if (listener && (typeof listener === 'function' || typeof listener.handleEvent === 'function')) {
          const wrapped = getAls().takeWrappedListener(type, listener, options);
          return originalRemove.call(this, type, wrapped ?? listener, options);
        }

        return originalRemove.call(this, type, listener, options);
      };
    }
  }
}

export function getGlobalBrowserALS<T extends object = object>(): BrowserALS<T> {
  const g = runtime();
  if (!g) throw new Error('BrowserALS requires globalThis');
  if (!g[ALS_KEY]) {
    g[ALS_KEY] = new BrowserALS<object>();
  }
  const als = g[ALS_KEY] as BrowserALS<T>;
  als.patch();
  return als;
}
