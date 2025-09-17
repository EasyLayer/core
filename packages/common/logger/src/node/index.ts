import { AppLogger } from './app-logger.service';
export * from './app-logger.service';
export * from './nest-logger';
export * from './bootstrap';
export * from './context';

// For non-Nest usage: call once at bootstrap.
export const configureRootLogger = AppLogger.configureRoot;
