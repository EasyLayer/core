import { Injectable } from '@nestjs/common';
import type { BunyanInstance } from './bunyan-service';
import { configureRootBunyan, getRootBunyan, isLoggingEnabled, deerrorize } from './bunyan-service';
import type { IAppLogger, LogLevel, LogMeta, RootLoggerOptions } from '../core';
import { ContextService } from './context';

/** Application logger (bunyan backend) with ALS context. */
@Injectable()
export class AppLogger implements IAppLogger {
  private logger: BunyanInstance;
  private opts!: RootLoggerOptions;

  constructor(
    private readonly ctx: ContextService,
    opts: RootLoggerOptions
  ) {
    this.opts = opts;
    this.logger = getRootBunyan(opts);
  }

  /** Programmatic root initialization (safe to call once at bootstrap). */
  static configureRoot(opts: RootLoggerOptions) {
    configureRootBunyan(opts);
  }

  /** Return a child logger; preserves the same ALS context reference. */
  child(component: string): IAppLogger {
    const childLogger = this.logger.child({ component }, true);
    const wrap = (level: LogLevel, message: string, meta?: LogMeta, withCtx?: boolean) => {
      if (!isLoggingEnabled()) return;
      const payload = this.normalizeMeta(level, meta, withCtx);
      // @ts-ignore
      childLogger[level](payload, message);
    };
    return {
      trace: (m, meta) => wrap('trace', m, meta, false),
      debug: (m, meta) => wrap('debug', m, meta, true),
      info: (m, meta) => wrap('info', m, meta, false),
      warn: (m, meta) => wrap('warn', m, meta, false),
      error: (m, meta) => wrap('error', m, meta, true),
      fatal: (m, meta) => wrap('fatal', m, meta, false),
      child: (sub) => this.child(`${component}:${sub}`),
    };
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

  private do(level: LogLevel, message: string, meta?: LogMeta, withCtx = false) {
    if (!isLoggingEnabled()) return;
    const payload = this.normalizeMeta(level, meta, withCtx);
    // @ts-ignore
    this.logger[level](payload, message);
  }

  private normalizeMeta(level: LogLevel, meta?: LogMeta, withCtx = false): any {
    const cleaned = this.clean(meta);
    const base = withCtx ? this.withRequestCtx(cleaned) : cleaned;

    if (level === 'trace') {
      return base;
    }

    const { serviceName, ...rest } = base as LogMeta;
    return {
      module: rest.module ?? 'unknown',
      ...rest,
    };
  }

  private withRequestCtx(meta?: LogMeta): LogMeta {
    const m = this.clean(meta);
    const req = m.requestId ?? this.ctx?.get<string>('requestId');
    const batch = m.batchRequestIds ?? this.ctx?.get<string[]>('batchRequestIds');
    if (req) m.requestId = req;
    if (batch) m.batchRequestIds = batch;
    return m;
  }

  private clean(meta?: LogMeta): LogMeta {
    return deerrorize(meta || {});
  }
}
