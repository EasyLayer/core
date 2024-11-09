import { Injectable, LoggerService } from '@nestjs/common';
import { createLogger, BunyanInstance } from './bunyan-logger.service';

/**
 * NestLogger should be used to log system messages from Nest.
 * Not recommended to log business valuable messages.
 */
@Injectable()
export class NestLogger implements LoggerService {
  private logger: BunyanInstance;

  constructor() {
    this.logger = createLogger();
  }

  log(message: string, context?: string) {
    this.logger.info({ context }, message);
  }

  error(message: string, trace?: string, context?: string) {
    this.logger.error({ trace, context }, message);
  }

  warn(message: string, context?: string) {
    this.logger.warn({ context }, message);
  }

  debug?(message: any, context?: string) {
    this.logger.debug(message, {}, context);
  }

  verbose?(message: any, context?: string) {
    this.logger.debug(message, {}, context);
  }
}
