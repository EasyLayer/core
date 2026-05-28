import {
  nextRuntimeLogMetricsSnapshot,
  resetRuntimeLogMetricsState,
  resolveRuntimeLogMetricsOptions,
} from '../runtime-metrics';

describe('runtime log metrics', () => {
  beforeEach(() => resetRuntimeLogMetricsState(1000));

  it('emits uptime, since-last-log and sequence metrics', () => {
    const first = nextRuntimeLogMetricsSnapshot('info', undefined, 1250);
    const second = nextRuntimeLogMetricsSnapshot('info', undefined, 1750);

    expect(first.perf).toEqual({ uptimeMs: 250, sinceLastLogMs: 0, logSeq: 1 });
    expect(second.perf).toEqual({ uptimeMs: 750, sinceLastLogMs: 500, logSeq: 2 });
  });

  it('can disable runtime metrics', () => {
    expect(nextRuntimeLogMetricsSnapshot('info', { enabled: false }, 1250)).toEqual({});
  });

  it('resolves default memory levels without mutating options', () => {
    const resolved = resolveRuntimeLogMetricsOptions({ memoryLevels: ['error'] });
    expect(resolved.memoryLevels).toEqual(['error']);
    expect(resolved.includeUptimeMs).toBe(true);
  });
});
