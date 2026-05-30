import type { LogLevel, RuntimeLogMetricsOptions } from './types';

export interface RuntimeMemoryMetrics {
  rssMB: number;
  heapUsedMB: number;
  heapTotalMB?: number;
  externalMB?: number;
  arrayBuffersMB?: number;
}

export interface RuntimeLogMetricsSnapshot {
  perf?: {
    uptimeMs?: number;
    sinceLastLogMs?: number;
    logSeq?: number;
  };
  mem?: RuntimeMemoryMetrics;
}

const DEFAULT_MEMORY_LEVELS: LogLevel[] = ['info', 'warn', 'error', 'fatal'];

const state = {
  startedAtMs: Date.now(),
  lastLogAtMs: undefined as number | undefined,
  logSeq: 0,
};

function getProcessLike(): any | undefined {
  return typeof globalThis !== 'undefined' ? (globalThis as any).process : undefined;
}

function envDisablesRuntimeMetrics(): boolean {
  const value = getProcessLike()?.env?.LOGGER_RUNTIME_METRICS;
  return value === '0' || value === 'false';
}

function toMB(bytes: number | undefined): number {
  return Math.round(((bytes || 0) / 1048576) * 10) / 10;
}

export function defaultRuntimeLogMetricsOptions(): Required<RuntimeLogMetricsOptions> {
  return {
    enabled: !envDisablesRuntimeMetrics(),
    includeSinceLastLogMs: true,
    includeUptimeMs: true,
    includeLogSeq: true,
    includeMemory: true,
    memoryLevels: DEFAULT_MEMORY_LEVELS,
  };
}

export function resolveRuntimeLogMetricsOptions(
  options?: RuntimeLogMetricsOptions
): Required<RuntimeLogMetricsOptions> {
  const defaults = defaultRuntimeLogMetricsOptions();
  return {
    ...defaults,
    ...options,
    memoryLevels: options?.memoryLevels ?? defaults.memoryLevels,
  };
}

export function resetRuntimeLogMetricsState(nowMs = Date.now()): void {
  state.startedAtMs = nowMs;
  state.lastLogAtMs = undefined;
  state.logSeq = 0;
}

export function getRuntimeMemoryMetrics(): RuntimeMemoryMetrics | undefined {
  const proc = getProcessLike();
  if (typeof proc?.memoryUsage !== 'function') return undefined;
  const mu = proc.memoryUsage();
  return {
    rssMB: toMB(mu.rss),
    heapUsedMB: toMB(mu.heapUsed),
    heapTotalMB: toMB(mu.heapTotal),
    externalMB: toMB(mu.external),
    arrayBuffersMB: toMB(mu.arrayBuffers),
  };
}

export function nextRuntimeLogMetricsSnapshot(
  level: LogLevel,
  options?: RuntimeLogMetricsOptions,
  nowMs = Date.now()
): RuntimeLogMetricsSnapshot {
  const resolved = resolveRuntimeLogMetricsOptions(options);
  if (!resolved.enabled) return {};

  state.logSeq += 1;

  const perf: RuntimeLogMetricsSnapshot['perf'] = {};
  if (resolved.includeUptimeMs) perf.uptimeMs = nowMs - state.startedAtMs;
  if (resolved.includeSinceLastLogMs)
    perf.sinceLastLogMs = state.lastLogAtMs === undefined ? 0 : nowMs - state.lastLogAtMs;
  if (resolved.includeLogSeq) perf.logSeq = state.logSeq;

  state.lastLogAtMs = nowMs;

  const shouldIncludeMemory = resolved.includeMemory && resolved.memoryLevels.includes(level);
  const mem = shouldIncludeMemory ? getRuntimeMemoryMetrics() : undefined;

  return {
    ...(Object.keys(perf).length > 0 ? { perf } : {}),
    ...(mem ? { mem } : {}),
  };
}
