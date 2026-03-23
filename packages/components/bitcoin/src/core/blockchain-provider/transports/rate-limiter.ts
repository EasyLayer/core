import type { RateLimits } from './interfaces';

/**
 * Internal wrapper that remembers the original position of each request
 * and keeps a reference to the original request object.
 */
interface IndexedRequest<TReq = { method: string; params: any[] }> {
  originalIndex: number;
  ref: TReq;
}

// ── Internal Scheduler ────────────────────────────────────────────────────────

/**
 * Minimal async scheduler — drop-in replacement for Bottleneck.
 *
 * Three constraints:
 *   1. maxConcurrent  — semaphore: at most N batches running simultaneously
 *   2. minTime        — pacing: minimum gap between batch *starts* (ms)
 *   3. reservoir      — token bucket: cap total scheduled calls over a rolling window
 *
 * No eval, no Redis, no external dependencies — plain TypeScript.
 */
class Scheduler {
  private readonly maxConcurrent: number;
  private readonly minTime: number;

  private readonly reservoirEnabled: boolean;
  private reservoir: number;
  private readonly reservoirRefreshAmount: number;
  private readonly reservoirRefreshInterval: number;
  private reservoirTimer: ReturnType<typeof setInterval> | null = null;

  private running = 0;
  private lastStartTime = 0;
  private readonly queue: Array<() => void> = [];
  private stopped = false;

  constructor(config: {
    maxConcurrent: number;
    minTime: number;
    reservoir?: number;
    reservoirRefreshInterval?: number;
    reservoirRefreshAmount?: number;
  }) {
    this.maxConcurrent = config.maxConcurrent;
    this.minTime = config.minTime;

    this.reservoirEnabled = config.reservoir != null;
    this.reservoir = config.reservoir ?? Infinity;
    this.reservoirRefreshAmount = config.reservoirRefreshAmount ?? 0;
    this.reservoirRefreshInterval = config.reservoirRefreshInterval ?? 0;

    if (this.reservoirEnabled && this.reservoirRefreshInterval > 0) {
      this.reservoirTimer = setInterval(() => {
        this.reservoir = this.reservoirRefreshAmount;
        this.drain();
      }, this.reservoirRefreshInterval);
    }
  }

  /** Schedule fn — identical API to Bottleneck#schedule(fn). */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error('Scheduler stopped'));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      this.drain();
    });
  }

  /** Stop — identical API to Bottleneck#stop({ dropWaitingJobs }). */
  async stop(opts: { dropWaitingJobs?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (opts.dropWaitingJobs !== false) this.queue.length = 0;
    if (this.reservoirTimer !== null) {
      clearInterval(this.reservoirTimer);
      this.reservoirTimer = null;
    }
  }

  private drain(): void {
    if (this.stopped) return;
    if (this.queue.length === 0) return;
    if (this.running >= this.maxConcurrent) return;
    if (this.reservoirEnabled && this.reservoir <= 0) return;

    const now = Date.now();
    const elapsed = now - this.lastStartTime;

    if (elapsed < this.minTime) {
      setTimeout(() => this.drain(), this.minTime - elapsed);
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    if (this.reservoirEnabled) this.reservoir -= 1;
    this.running += 1;
    this.lastStartTime = Date.now();

    Promise.resolve()
      .then(task)
      .finally(() => {
        this.running -= 1;
        this.drain();
      });

    // Fill remaining concurrent slots immediately if available
    if (this.running < this.maxConcurrent) this.drain();
  }
}

// ── Public RateLimiter ────────────────────────────────────────────────────────

/**
 * RateLimiter — Bottleneck drop-in replacement.
 *
 * Identical public API:
 *   - constructor(config: RateLimits)
 *   - execute(requests, batchRpcCall): Promise<(T | null)[]>
 *   - stop(): Promise<void>
 *   - getConfig(): RateLimits
 *
 * Identical behavior:
 *   - Groups requests by method, splits into maxBatchSize chunks
 *   - Schedules each chunk through the Scheduler (concurrency + pacing + reservoir)
 *   - Preserves exact output order matching input order
 *   - Passes request objects by reference (no cloning)
 *   - Re-throws transport-level errors; item-level nulls handled inside batchRpcCall
 *
 * No eval, no Redis, no external runtime dependencies.
 */
export class RateLimiter {
  private limiter: Scheduler;
  private config: RateLimits;

  constructor(config: RateLimits = {}) {
    this.config = {
      maxConcurrentRequests: config.maxConcurrentRequests ?? 1,
      maxBatchSize: config.maxBatchSize ?? 15,
      minTimeMsBetweenRequests: config.minTimeMsBetweenRequests ?? config.requestDelayMs ?? 1000,
      reservoir: config.reservoir,
      reservoirRefreshInterval: config.reservoirRefreshInterval,
      reservoirRefreshAmount: config.reservoirRefreshAmount,
    };

    this.limiter = new Scheduler({
      maxConcurrent: this.config.maxConcurrentRequests!,
      minTime: this.config.minTimeMsBetweenRequests!,
      reservoir: config.reservoir,
      reservoirRefreshInterval: config.reservoirRefreshInterval,
      reservoirRefreshAmount: config.reservoirRefreshAmount,
    });
  }

  async execute<T>(
    requests: Array<{ method: string; params: any[] }>,
    batchRpcCall: (calls: typeof requests) => Promise<(T | null)[]>
  ): Promise<(T | null)[]> {
    if (requests.length === 0) return [];

    if (!this.config.maxBatchSize || this.config.maxBatchSize <= 0) {
      throw new Error('Batch size must be greater than 0');
    }

    const indexedRequests: IndexedRequest[] = requests.map((req, idx) => ({
      originalIndex: idx,
      ref: req,
    }));

    const methodGroups = new Map<string, IndexedRequest[]>();
    for (const ir of indexedRequests) {
      const key = ir.ref.method;
      const group = methodGroups.get(key);
      if (group) group.push(ir);
      else methodGroups.set(key, [ir]);
    }

    const batches: { requests: IndexedRequest[]; method: string }[] = [];
    for (const [method, group] of methodGroups) {
      for (let i = 0; i < group.length; i += this.config.maxBatchSize!) {
        const chunk = group.slice(i, i + this.config.maxBatchSize!);
        if (chunk.length === 0) break;
        batches.push({ requests: chunk, method });
      }
    }

    const results: (T | null)[] = new Array(requests.length).fill(null);

    for (const batch of batches) {
      try {
        const plainRequests = batch.requests.map((ir) => ir.ref);
        const batchResults = await this.limiter.schedule(() => batchRpcCall(plainRequests));

        if (!Array.isArray(batchResults)) continue;

        for (let i = 0; i < batch.requests.length; i++) {
          const ir = batch.requests[i]!;
          results[ir.originalIndex] = i < batchResults.length ? (batchResults[i] as T | null) : null;
        }
      } catch (err) {
        // Re-throw transport-level errors so provider failover logic triggers.
        // Item-level RPC errors are returned as null inside batchRpcCall.
        throw err;
      }
    }

    return results;
  }

  async stop(): Promise<void> {
    await this.limiter.stop({ dropWaitingJobs: true });
  }

  getConfig(): RateLimits {
    return this.config;
  }
}
