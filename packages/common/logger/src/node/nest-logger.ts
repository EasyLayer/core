import type { LoggerService } from '@nestjs/common';
import { getRootBunyan, configureRootBunyan, deerrorize } from './bunyan-service';
import { getGlobalContext } from './context';
import type { LogLevel, LogMeta, RootLoggerOptions } from '../core';

export type NestLoggerOptions = RootLoggerOptions;
type NestLoggerParams = any[];

/**
 * Nest LoggerService adapter to bunyan.
 * - Maps log() -> info
 * - Maps verbose() -> trace
 * - Injects ALS request context for debug/error
 * - Uses class context from Nest Logger as serviceName, but only emits serviceName on trace logs
 * - Uses module as the primary business context for non-trace logs
 */
export class NestLogger implements LoggerService {
  private opts!: NestLoggerOptions;

  constructor(opts: NestLoggerOptions) {
    this.opts = opts;
    configureRootBunyan({
      name: opts.name,
      level: opts.level,
      enabled: opts.enabled,
      filePath: opts.filePath,
    });
    getGlobalContext();
  }

  log(message: any, ...optionalParams: NestLoggerParams) {
    this.write('info', message, optionalParams, false);
  }

  warn(message: any, ...optionalParams: NestLoggerParams) {
    this.write('warn', message, optionalParams, false);
  }

  debug(message: any, ...optionalParams: NestLoggerParams) {
    this.write('debug', message, optionalParams, true);
  }

  verbose(message: any, ...optionalParams: NestLoggerParams) {
    this.write('trace', message, optionalParams, false);
  }

  error(message: any, ...optionalParams: NestLoggerParams) {
    this.write('error', message, optionalParams, true);
  }

  fatal(message: any, ...optionalParams: NestLoggerParams) {
    this.write('fatal', message, optionalParams, false);
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

  private write(level: LogLevel, message: any, optionalParams: NestLoggerParams, withCtx?: boolean) {
    const root = getRootBunyan(this.opts);
    const normalized = this.normalizeParams(level, optionalParams);
    const base = {
      ...normalized,
      ...this.payload(withCtx),
    };

    root[level](base, typeof message === 'string' ? message : String(message));
  }

  private normalizeParams(level: LogLevel, optionalParams: NestLoggerParams): LogMeta {
    const params = [...optionalParams];
    let serviceName: string | undefined;

    if (typeof params[params.length - 1] === 'string') {
      serviceName = params.pop() as string;
    }

    const meta = this.takeMeta(params);
    const extraArgs = this.normalizeExtraArgs(level, params);

    const out: LogMeta = {
      ...(level === 'trace' && serviceName ? { serviceName } : {}),
      ...(level === 'trace' && meta.serviceName ? { serviceName: meta.serviceName } : {}),
      ...(meta.module ? { module: meta.module } : {}),
      ...(meta.methodName ? { methodName: meta.methodName } : {}),
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      ...(meta.batchRequestIds ? { batchRequestIds: meta.batchRequestIds } : {}),
    };

    const args = this.mergeArgs(level, meta.args, extraArgs);
    if (args !== undefined) out.args = args;

    if (level !== 'trace' && !out.module) {
      out.module = 'unknown';
    }

    return out;
  }

  private takeMeta(params: NestLoggerParams): LogMeta {
    const index = params.findIndex((value) => this.isPlainObject(value));
    if (index === -1) return {};

    const [candidate] = params.splice(index, 1);
    return this.normalizeMetaObject(candidate as Record<string, unknown>);
  }

  private normalizeMetaObject(input: Record<string, unknown>): LogMeta {
    const { serviceName, module, methodName, requestId, batchRequestIds, args, ...rest } = input;

    return {
      ...(typeof serviceName === 'string' ? { serviceName } : {}),
      ...(typeof module === 'string' ? { module } : {}),
      ...(typeof methodName === 'string' ? { methodName } : {}),
      ...(typeof requestId === 'string' ? { requestId } : {}),
      ...(Array.isArray(batchRequestIds) ? { batchRequestIds: batchRequestIds as string[] } : {}),
      ...(args !== undefined ? { args: args } : Object.keys(rest).length > 0 ? { args: rest } : {}),
    };
  }

  private normalizeExtraArgs(level: LogLevel, params: NestLoggerParams): unknown {
    if (params.length === 0) return undefined;

    if (level === 'error' && params.length === 1 && params[0] instanceof Error) {
      return { error: params[0] };
    }

    if (level === 'error' && params.length === 1 && typeof params[0] === 'string') {
      return { trace: params[0] };
    }

    if (level === 'error' && params.length === 2 && params[0] instanceof Error && typeof params[1] === 'string') {
      return {
        error: params[0],
        trace: params[1],
      };
    }

    return params.length === 1 ? params[0] : params;
  }

  private mergeArgs(level: LogLevel, metaArgs: unknown, extraArgs: unknown): unknown {
    if (metaArgs === undefined) return extraArgs === undefined ? undefined : deerrorize(extraArgs);
    if (extraArgs === undefined) return deerrorize(metaArgs);

    if (this.isPlainObject(metaArgs) && this.isPlainObject(extraArgs)) {
      return deerrorize({ ...(metaArgs as Record<string, unknown>), ...(extraArgs as Record<string, unknown>) });
    }

    return deerrorize({
      args: metaArgs,
      extra: extraArgs,
      level,
    });
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error);
  }
}
