import type { ContextService } from '@easylayer/common/context';
import type { BunyanInstance } from './bunyan-logger.service';
import { createLogger } from './bunyan-logger.service';

/**
 * Metadata that can be attached to a log entry.
 */
export interface LogMeta {
  /**
   * Optional service or any other label.
   */
  serviceName?: string;

  /**
   * Optional method name.
   */
  methodName?: string;
  /**
   * Additional arbitrary data to include (e.g. request parameters, error objects).
   */
  args?: unknown;
  /**
   * Override requestId if explicitly provided.
   */
  requestId?: string;
  /**
   * Override batchRequestIds if explicitly provided.
   */
  batchRequestIds?: string[];
}

/**
 * Defines the public logging API for the application.
 */
export interface IAppLogger {
  /**
   * Logs an informational message.
   * @param message - The message text to log.
   * @param meta - Optional metadata such as context or args.
   */
  info(message: string, meta?: LogMeta): void;

  /**
   * Logs an error message.
   * @param message - The error message text.
   * @param meta - Optional metadata; if `meta.args` is an Error, its message and stack will be extracted.
   */
  error(message: string, meta?: LogMeta): void;

  /**
   * Logs a debug message.
   * @param message - The debug message text.
   * @param meta - Optional additional metadata.
   */
  debug(message: string, meta?: LogMeta): void;

  /**
   * Logs a warning message.
   * @param message - The warning message text.
   * @param meta - Optional metadata.
   */
  warn(message: string, meta?: LogMeta): void;

  /**
   * Logs a fatal error message, indicating a critical failure.
   * @param message - The fatal error message text.
   * @param meta - Optional metadata.
   */
  fatal(message: string, meta?: LogMeta): void;

  /**
   * Creates a child logger that automatically includes the given component name in each entry.
   * @param component - The name of the component or module for this child logger.
   * @returns A new logger instance scoped to the specified component.
   */
  child(component: string): IAppLogger;

  /**
   * Optionally set a service name that will be added into every meta.
   */
  // setContext(serviceName: string): this;
}

/**
 * Application logger implementation that wraps a BunyanInstance.
 * Provides structured logging methods and enforces `requestId` on debug.
 */
export class AppLogger implements IAppLogger {
  private currentServiceName?: string;
  private logger: BunyanInstance;
  /**
   * Construct a new AppLogger.
   * @param ctx - The context service providing AsyncLocalStorage.
   */
  constructor(private readonly ctx: ContextService) {
    this.logger = createLogger();
  }

  // setContext(serviceName: string): this {
  //   this.currentServiceName = serviceName;
  //   return this;
  // }

  child(component: string): IAppLogger {
    const childLogger = this.logger.child({ component }, /* simple */ true);
    const child = new AppLogger(this.ctx);
    child.logger = childLogger;
    return child;
  }

  /**
   * Remove any undefined fields from a metadata object before logging.
   * @param meta - The metadata to filter.
   * @returns A new object containing only defined metadata properties.
   */
  private filterMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
    return Object.entries(meta).reduce(
      (acc, [key, value]) => {
        if (value !== undefined) (acc as any)[key] = value;
        return acc;
      },
      {} as Record<string, unknown>
    );
  }

  /**
   * Core logging call without injecting context.
   */
  private logNoContext(level: keyof IAppLogger, message: string, meta: LogMeta = {}) {
    const mergedMeta: LogMeta = {
      ...meta,
      ...(this.currentServiceName ? { serviceName: this.currentServiceName } : {}),
    };
    // @ts-expect-error: BunyanInstance[level] exists
    this.logger[level](this.filterMeta(mergedMeta), message);
  }

  /**
   * Logging call for debug level: injects requestId or batchRequestIds if present.
   */
  private logWithContext(level: keyof IAppLogger, message: string, meta: LogMeta = {}) {
    const explicitRequestId = meta.requestId;
    const explicitBatchRequestIds = meta.batchRequestIds;
    const contextRequestId = this.ctx.get<string>('requestId');
    const contextBatchRequestIds = this.ctx.get<string[]>('batchRequestIds');

    const merged: Record<string, unknown> = { ...meta };
    if (explicitRequestId || contextRequestId) {
      merged.requestId = explicitRequestId ?? contextRequestId;
    }
    if (explicitBatchRequestIds || contextBatchRequestIds) {
      merged.batchRequestIds = explicitBatchRequestIds ?? contextBatchRequestIds;
    }
    if (this.currentServiceName) {
      (merged as LogMeta).serviceName = this.currentServiceName;
    }

    // @ts-expect-error
    this.logger[level](this.filterMeta(meta), message);
  }

  info(message: string, meta?: LogMeta): void {
    this.logNoContext('info', message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    if (meta?.args instanceof Error) {
      meta = {
        ...meta,
        args: { message: meta.args.message, stack: meta.args.stack },
      };
    }
    this.logNoContext('error', message, meta);
  }

  debug(message: string, meta?: LogMeta): void {
    this.logWithContext('debug', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.logNoContext('warn', message, meta);
  }

  fatal(message: string, meta?: LogMeta): void {
    this.logNoContext('fatal', message, meta);
  }
}
