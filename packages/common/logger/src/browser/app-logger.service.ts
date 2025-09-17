import { Injectable } from '@nestjs/common';
import type { IAppLogger, LogMeta, RootLoggerOptions, LogLevel } from '../core';
import { ContextService } from './context';

type Lvl = LogLevel;
const order: Record<Lvl, number> = { trace: 5, debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

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
    const payload = meta ? JSON.stringify(meta, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) : '';
    const line = `[${level.toUpperCase()}] ${ts} ${this.name} ${message} ${payload}`;
    // eslint-disable-next-line no-console
    if (level === 'fatal' || level === 'error') console.error(line);
    // eslint-disable-next-line no-console
    else if (level === 'warn') console.warn(line);
    // eslint-disable-next-line no-console
    else if (level === 'info') console.info(line);
    // eslint-disable-next-line no-console
    else console.debug(line);
  }
}

const state = {
  root: new ConsoleRoot('App', 'info', true),
};

export function configureRootConsole(opts: RootLoggerOptions = {}) {
  state.root.configure(opts.name || 'App', (opts.level ?? 'info') as Lvl, opts.enabled !== false);
  return state.root;
}

export function getRootConsole() {
  return state.root;
}

@Injectable()
export class AppLogger implements IAppLogger {
  private root = getRootConsole();

  constructor(private readonly ctx?: ContextService) {}

  /** Programmatic initialization without Nest. Call once early in bootstrap. */
  static configureRoot(opts?: RootLoggerOptions) {
    configureRootConsole(opts);
  }

  child(component: string): IAppLogger {
    const c = new AppLogger(this.ctx);
    (c as any).root = this.root.child(component);
    return c;
  }

  private withDebugCtx(meta?: LogMeta): any {
    const m = { ...(meta || {}) };
    const req = m.requestId ?? this.ctx?.get<string>('requestId');
    const batch = m.batchRequestIds ?? this.ctx?.get<string[]>('batchRequestIds');
    if (req) m.requestId = req;
    if (batch) m.batchRequestIds = batch;
    if (m.args instanceof Error) m.args = { message: m.args.message, stack: m.args.stack };
    return m;
  }

  private pass(meta?: LogMeta): any {
    const m = { ...(meta || {}) };
    if (m.args instanceof Error) m.args = { message: m.args.message, stack: m.args.stack };
    return m;
  }

  private do(level: Lvl, message: string, meta?: LogMeta, withCtx = false) {
    const payload = withCtx ? this.withDebugCtx(meta) : this.pass(meta);
    this.root.write(level, message, payload);
  }

  trace(m: string, meta?: LogMeta) {
    this.do('trace', m, meta, false);
  }
  debug(m: string, meta?: LogMeta) {
    this.do('debug', m, meta, true);
  } // requestId only here
  info(m: string, meta?: LogMeta) {
    this.do('info', m, meta, false);
  }
  warn(m: string, meta?: LogMeta) {
    this.do('warn', m, meta, false);
  }
  error(m: string, meta?: LogMeta) {
    this.do('error', m, meta, false);
  }
  fatal(m: string, meta?: LogMeta) {
    this.do('fatal', m, meta, false);
  }
}
