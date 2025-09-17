import type { LoggerService } from '@nestjs/common';
import { getRootBunyan, configureRootBunyan, deerrorize } from './bunyan-service';
import { getGlobalContext } from './context';
import type { LogLevel, RootLoggerOptions } from '../core';

export type NestLoggerOptions = Partial<RootLoggerOptions>;

/**
 * Nest LoggerService adapter to bunyan.
 * - Can initialize bunyan root (if opts are provided).
 * - Injects ALS context (requestId, batchRequestIds) for debug/fatal.
 * - Maps .error(message, trace, context) -> bunyan.fatal, attaches trace to meta.
 */
export class NestLogger implements LoggerService {
  constructor(opts: NestLoggerOptions) {
    if (opts) {
      configureRootBunyan({
        name: opts.name,
        level: opts.level,
        enabled: opts.enabled,
        filePath: opts.filePath,
      });
    }
    getGlobalContext();
  }

  log(m: any, c?: string) {
    this.write('info', m, c);
  }
  warn(m: any, c?: string) {
    this.write('warn', m, c);
  }
  debug(m: any, c?: string) {
    this.write('debug', m, c, true);
  }
  verbose?(m: any, c?: string) {
    this.write('trace', m, c);
  }
  error(m: any, trace?: string, c?: string) {
    this.write('fatal', m, c, true, trace ? { trace } : undefined);
  }

  private payload(includeCtx?: boolean) {
    if (!includeCtx) return {};
    const ctx = getGlobalContext();
    const requestId = ctx.get<string>('requestId');
    const batch = ctx.get<string[]>('batchRequestIds');
    return {
      ...(requestId ? { requestId } : {}),
      ...(Array.isArray(batch) && batch.length ? { batchRequestIds: batch } : {}),
    };
  }

  private write(level: LogLevel, message: any, context?: string, withCtx?: boolean, meta?: any) {
    const root = getRootBunyan();
    const base = {
      serviceName: context,
      ...(meta ? { args: deerrorize(meta) } : {}),
      ...this.payload(withCtx),
    };
    // @ts-ignore bunyan dynamic level
    root[level](base, typeof message === 'string' ? message : String(message));
  }
}
