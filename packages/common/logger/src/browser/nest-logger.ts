import type { LoggerService } from '@nestjs/common';
import { getRootConsole, configureRootConsole, deerrorize } from './app-logger.service';
import { getGlobalContext } from './context';
import type { LogLevel, LogMeta, RootLoggerOptions } from '../core';

export type NestLoggerOptions = RootLoggerOptions;
type NestLoggerParams = any[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isReservedMetaKey(key: string): boolean {
  return (
    key === 'serviceName' ||
    key === 'module' ||
    key === 'methodName' ||
    key === 'requestId' ||
    key === 'batchRequestIds' ||
    key === 'args'
  );
}

/**
 * Nest LoggerService adapter to the EasyLayer console logger.
 *
 * Rules:
 * - log() -> info
 * - verbose() -> trace
 * - debug()/error() enrich payload with ALS request context
 * - serviceName is taken from Nest context (new Logger(MyService.name)) and emitted only for trace logs
 * - module is the primary non-trace context and should be passed explicitly in meta
 * - args is the canonical container for structured parameters
 */
export class NestLogger implements LoggerService {
  private opts: NestLoggerOptions;

  constructor(opts: NestLoggerOptions) {
    this.opts = opts;
    configureRootConsole({
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

  verbose?(message: any, ...optionalParams: NestLoggerParams) {
    this.write('trace', message, optionalParams, false);
  }

  error(message: any, ...optionalParams: NestLoggerParams) {
    this.write('error', message, optionalParams, true);
  }

  fatal?(message: any, ...optionalParams: NestLoggerParams) {
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

    if (level !== 'trace' && !out.module) {
      out.module = 'unknown';
    }

    const args = this.mergeArgs(meta.args, extraArgs);
    if (args !== undefined) out.args = args;

    return out;
  }

  private takeMeta(params: any[]): LogMeta {
    const metaIndex = params.findIndex((value) => isPlainObject(value));
    if (metaIndex < 0) return {};

    const rawMeta = params.splice(metaIndex, 1)[0] as Record<string, unknown>;
    const serviceName = typeof rawMeta.serviceName === 'string' ? rawMeta.serviceName : undefined;
    const module = typeof rawMeta.module === 'string' ? rawMeta.module : undefined;
    const methodName = typeof rawMeta.methodName === 'string' ? rawMeta.methodName : undefined;
    const requestId = typeof rawMeta.requestId === 'string' ? rawMeta.requestId : undefined;
    const batchRequestIds = Array.isArray(rawMeta.batchRequestIds)
      ? rawMeta.batchRequestIds.filter((v): v is string => typeof v === 'string')
      : undefined;

    let args: unknown;
    if ('args' in rawMeta) {
      args = rawMeta.args;
    } else {
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawMeta)) {
        if (!isReservedMetaKey(key)) rest[key] = value;
      }
      if (Object.keys(rest).length > 0) args = rest;
    }

    return {
      ...(serviceName ? { serviceName } : {}),
      ...(module ? { module } : {}),
      ...(methodName ? { methodName } : {}),
      ...(requestId ? { requestId } : {}),
      ...(batchRequestIds && batchRequestIds.length ? { batchRequestIds } : {}),
      ...(args !== undefined ? { args } : {}),
    };
  }

  private normalizeExtraArgs(level: LogLevel, params: any[]): unknown {
    if (!params.length) return undefined;

    if (level === 'error') {
      if (params.length === 1) {
        const [single] = params;
        if (single instanceof Error) return { error: single };
        if (typeof single === 'string') return { trace: single };
      }

      const out: Record<string, unknown> = {};
      const traces: string[] = [];
      const errors: Error[] = [];

      for (const value of params) {
        if (value instanceof Error) {
          errors.push(value);
          continue;
        }
        if (typeof value === 'string') {
          traces.push(value);
          continue;
        }
      }

      if (errors.length === 1) out.error = errors[0];
      else if (errors.length > 1) out.errors = errors;

      if (traces.length === 1) out.trace = traces[0];
      else if (traces.length > 1) out.traces = traces;

      return Object.keys(out).length ? out : { extraParams: params };
    }

    if (params.length === 1) {
      const [single] = params;
      if (single instanceof Error) return { error: single };
      return { value: single };
    }

    return { values: params };
  }

  private mergeArgs(metaArgs: unknown, extraArgs: unknown): unknown {
    if (metaArgs === undefined) return extraArgs;
    if (extraArgs === undefined) return metaArgs;

    const left = isPlainObject(metaArgs) ? metaArgs : { value: metaArgs };
    const right = isPlainObject(extraArgs) ? extraArgs : { extra: extraArgs };

    return {
      ...left,
      ...right,
    };
  }

  private write(level: LogLevel, message: any, optionalParams: NestLoggerParams, withCtx?: boolean) {
    const root = getRootConsole();
    const payload = this.normalizeParams(level, optionalParams);
    const base = {
      ...payload,
      ...this.payload(withCtx),
    };

    root.write(level, typeof message === 'string' ? message : String(message), base);
  }
}
