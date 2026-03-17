import { Injectable } from '@nestjs/common';
import type { IAppLogger, LogMeta, RootLoggerOptions, LogLevel } from '../core';
import { ContextService } from './context';

type Lvl = LogLevel;
const order: Record<Lvl, number> = { trace: 5, debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

export function deerrorize(v: any): any {
  if (v instanceof Error) return { message: v.message, stack: v.stack };
  if (Array.isArray(v)) return v.map(deerrorize);
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const k of Object.keys(v)) out[k] = deerrorize(v[k]);
    return out;
  }
  return v;
}

const styles: Record<Lvl, string> = {
  trace: 'color:#9e9e9e',
  debug: 'color:#f59e0b',
  info: 'color:#3b82f6',
  warn: 'color:#22c55e',
  error: 'color:#ef4444',
  fatal: 'color:#ef4444;font-weight:bold;text-decoration:underline',
};

class ConsoleRoot {
  constructor(
    private name: string,
    private level: Lvl,
    private enabled: boolean
  ) {}

  configure(name: string, level: Lvl, enabled: boolean) {
    this.name = name;
    this.level = level;
    this.enabled = enabled;
  }

  child(component: string) {
    return new ConsoleRoot(`${this.name}:${component}`, this.level, this.enabled);
  }

  write(level: Lvl, message: string, meta?: any) {
    if (!this.enabled) return;
    if (order[level] < order[this.level]) return;

    const ts = new Date().toISOString();
    const msg = typeof message === 'string' ? message : String(message);
    const normMeta = meta ? deerrorize(meta) : undefined;

    const prefixParts = [`[${level.toUpperCase()}]`, ts, this.name];
    if (level === 'trace' && normMeta?.serviceName) {
      prefixParts.push(normMeta.serviceName);
    }
    if (level !== 'trace' && normMeta?.module) {
      prefixParts.push(`module=${normMeta.module}`);
    }

    const fmt = `%c${prefixParts.join(' ')}%c ${msg}`;
    const c1 = styles[level];
    const c2 = 'color:inherit';

    const logFn =
      level === 'fatal' || level === 'error'
        ? // eslint-disable-next-line no-console
          console.error
        : level === 'warn'
          ? // eslint-disable-next-line no-console
            console.warn
          : level === 'info'
            ? // eslint-disable-next-line no-console
              console.info
            : // eslint-disable-next-line no-console
              console.debug;

    if (normMeta) logFn(fmt, c1, c2, deerrorize(normMeta));
    else logFn(fmt, c1, c2);
  }
}

const KEY = Symbol.for('root');
type State = { root: ConsoleRoot };
function _state(): State {
  const g = globalThis as any;
  if (!g[KEY]) g[KEY] = { root: new ConsoleRoot('app', 'info', true) };
  return g[KEY] as State;
}

export function configureRootConsole(opts: RootLoggerOptions) {
  const name = opts.name;
  const level = (opts.level ?? 'info') as Lvl;
  const enabled = opts.enabled !== false;
  _state().root.configure(name, level, enabled);
  return _state().root;
}

export function getRootConsole() {
  return _state().root;
}

@Injectable()
export class AppLogger implements IAppLogger {
  private root = getRootConsole();

  constructor(private readonly ctx?: ContextService) {}

  /** Programmatic initialization without Nest. Call once early in bootstrap. */
  static configureRoot(opts: RootLoggerOptions) {
    configureRootConsole(opts);
  }

  child(component: string): IAppLogger {
    const c = new AppLogger(this.ctx);
    (c as any).root = this.root.child(component);
    return c;
  }

  private withCtx(meta?: LogMeta): any {
    const m = this.pass(meta);
    const req = m.requestId ?? this.ctx?.get<string>('requestId');
    const batch = m.batchRequestIds ?? this.ctx?.get<string[]>('batchRequestIds');
    if (req) m.requestId = req;
    if (batch) m.batchRequestIds = batch;
    return m;
  }

  private pass(meta?: LogMeta): any {
    const m = deerrorize({ ...(meta || {}) });
    if ((m.module === undefined || m.module === null || m.module === '') && m.serviceName !== undefined) {
      delete m.serviceName;
    }
    return m;
  }

  private traceMeta(meta?: LogMeta): any {
    const m = this.pass(meta);
    if (!m.serviceName) m.serviceName = 'app';
    return m;
  }

  private do(level: Lvl, message: string, meta?: LogMeta, withCtx = false) {
    const payload = level === 'trace' ? this.traceMeta(meta) : withCtx ? this.withCtx(meta) : this.pass(meta);
    if (level !== 'trace' && !payload.module) {
      payload.module = 'unknown';
    }
    if (level !== 'trace' && payload.serviceName) {
      delete payload.serviceName;
    }
    this.root.write(level, message, payload);
  }

  trace(m: string, meta?: LogMeta) {
    this.do('trace', m, meta, false);
  }

  debug(m: string, meta?: LogMeta) {
    this.do('debug', m, meta, true);
  }

  info(m: string, meta?: LogMeta) {
    this.do('info', m, meta, false);
  }

  warn(m: string, meta?: LogMeta) {
    this.do('warn', m, meta, false);
  }

  error(m: string, meta?: LogMeta) {
    this.do('error', m, meta, true);
  }

  fatal(m: string, meta?: LogMeta) {
    this.do('fatal', m, meta, false);
  }
}
