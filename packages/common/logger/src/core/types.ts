export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogMeta {
  serviceName?: string;
  module?: string;
  methodName?: string;
  args?: unknown;
  requestId?: string;
  batchRequestIds?: string[];
}

export interface RuntimeLogMetricsOptions {
  enabled?: boolean;
  includeSinceLastLogMs?: boolean;
  includeUptimeMs?: boolean;
  includeLogSeq?: boolean;
  includeMemory?: boolean;
  memoryLevels?: LogLevel[];
}

export interface RootLoggerOptions {
  name: string; // root logger name
  level?: LogLevel; // global level threshold
  enabled?: boolean; // turn off completely
  filePath?: string; // node-only: optional log file for production
  runtimeMetrics?: RuntimeLogMetricsOptions; // optional global perf/memory enrichment
}

export interface FeatureLoggerOptions {
  componentName: string;
}

export interface IAppLogger {
  trace(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  fatal(message: string, meta?: LogMeta): void;
  child(component: string): IAppLogger;
}
