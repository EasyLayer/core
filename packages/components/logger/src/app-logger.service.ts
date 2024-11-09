import { createLogger, BunyanInstance } from './bunyan-logger.service';

export interface IAppLogger {
  info(message: string, args?: any, context?: any): void;
  error(message: string, args?: any, context?: any): void;
  debug(message: string, args?: any, context?: any): void;
  warn(message: string, args?: any, context?: any): void;
  fatal(message: string, args?: any, context?: any): void;
  child(childName: string): IAppLogger;
}

export class AppLogger implements IAppLogger {
  constructor(private logger: BunyanInstance = createLogger()) {}

  info(message: string, args?: any, context?: string): void {
    this.logger.info({ args, context }, message);
  }

  error(message: string, args?: any, context?: string): void {
    if (args instanceof Error) {
      this.logger.error({ args, context }, `${message}: ${args.toString()}`);
    } else {
      this.logger.error({ args, context }, message);
    }
  }

  debug(message: string, args?: any, context?: string): void {
    this.logger.debug({ args, context }, message);
  }

  warn(message: string, args?: any, context?: string): void {
    this.logger.warn({ args, context }, message);
  }

  fatal(message: string, args?: any, context?: string): void {
    this.logger.fatal({ args, context }, message);
  }

  child(childName: string, simple: boolean = true): IAppLogger {
    // If "simple" is set to "true"
    // the child logger will be created to ignore some of the parent logger's settings.
    // For example, it ignores settings such as serializers or logging levels specified in the parent.
    const childProvider = this.logger.child({ component: childName }, simple);
    return new AppLogger(childProvider);
  }
}
