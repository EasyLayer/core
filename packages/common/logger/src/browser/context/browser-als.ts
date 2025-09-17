type Fn = (...args: any[]) => any;

export class BrowserALS<T extends object> {
  private store: T | undefined;
  private patched = false;

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

  patch(): void {
    if (this.patched) return;
    this.patched = true;

    const _then = Promise.prototype.then;
    // @ts-ignore
    Promise.prototype.then = function (onFulfilled?: Fn, onRejected?: Fn) {
      const als = (window as any).__ctxAls as BrowserALS<T>;
      const f = onFulfilled ? als.bind(onFulfilled) : undefined;
      const r = onRejected ? als.bind(onRejected) : undefined;
      return _then.call(this, f, r);
    };

    const _qmt = window.queueMicrotask?.bind(window);
    if (_qmt) {
      window.queueMicrotask = ((cb: Fn) => {
        const als = (window as any).__ctxAls as BrowserALS<T>;
        return _qmt(als.bind(cb));
      }) as typeof window.queueMicrotask;
    }

    const _setTimeout = window.setTimeout.bind(window);
    const _setInterval = window.setInterval.bind(window);
    window.setTimeout = ((cb: Fn, ms?: number, ...rest: any[]) => {
      const als = (window as any).__ctxAls as BrowserALS<T>;
      return _setTimeout(als.bind(cb), ms as any, ...rest);
    }) as typeof window.setTimeout;
    window.setInterval = ((cb: Fn, ms?: number, ...rest: any[]) => {
      const als = (window as any).__ctxAls as BrowserALS<T>;
      return _setInterval(als.bind(cb), ms as any, ...rest);
    }) as typeof window.setInterval;

    const _add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type: string, listener: any, options?: any) {
      if (typeof listener === 'function') {
        const als = (window as any).__ctxAls as BrowserALS<T>;
        const wrapped = als.bind(listener);
        (wrapped as any).__orig = listener;
        return _add.call(this, type, wrapped, options);
      }
      return _add.call(this, type, listener, options);
    };

    const _remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function (type: string, listener: any, options?: any) {
      const maybeWrapped = (listener && (listener as any).__orig) || listener;
      return _remove.call(this, type, maybeWrapped, options);
    };
  }
}

(function ensureGlobal() {
  const w = window as any;
  if (!w.__ctxAls) {
    w.__ctxAls = new BrowserALS<object>();
    w.__ctxAls.patch();
  }
})();
