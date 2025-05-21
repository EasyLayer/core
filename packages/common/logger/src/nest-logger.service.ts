import { Injectable, LoggerService } from '@nestjs/common';
import { createLogger, BunyanInstance } from './bunyan-logger.service';

/**
 * Adapter that implements NestJS’s LoggerService using a Bunyan-based logger.
 *
 * This logger only emits:
 *  - FATAL (`error`) messages.
 *
 * All other NestJS log levels (`info`, `warn`, `debug`, `verbose`) are no-ops.
 */
@Injectable()
export class NestLogger implements LoggerService {
  private readonly logger: BunyanInstance;

  /**
   * Create a new NestLogger.
   * Internally it will call `createLogger()` to get a Bunyan instance.
   */
  constructor() {
    this.logger = createLogger();
  }

  /**
   * Log a standard system message at INFO level.
   * @param message - The message text.
   * @param context - Optional context (e.g. class or module name).
   */
  log(message: string, context?: string): void {
    // no-op
  }

  /**
   * Log an error at FATAL level.
   *
   * Extracts the Bunyan “component” (if any) or logger name
   * and includes it alongside the provided trace and context.
   * @param message - The error message.
   * @param trace   - Optional stack trace or additional trace info.
   * @param context - Optional context (e.g. class or module name).
   */
  error(message: string, trace?: string, context?: string): void {
    // Attempt to pull the child “component” field or fallback to the logger’s name
    const component = (this.logger as any).fields?.component ?? this.logger.fields?.name;
    this.logger.fatal({ trace, context, component }, message);
  }

  /**
   * Warning-level messages are ignored by this adapter.
   * @param message - The warning message.
   * @param context - Optional context (unused).
   */
  warn(message: string, context?: string): void {
    // no-op
  }

  /**
   * Debug-level messages are ignored by this adapter.
   * @param message - The debug data.
   * @param context - Optional context (unused).
   */
  debug?(message: any, context?: string): void {
    // no-op
  }

  /**
   * Verbose-level messages are ignored by this adapter.
   * @param message - The verbose data.
   * @param context - Optional context (unused).
   */
  verbose?(message: any, context?: string): void {
    // no-op
  }
}
