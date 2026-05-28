import type { RateLimits } from './interfaces';

/**
 * Internal wrapper that remembers the original position of each request
 * and keeps a reference to the original request object.
 */
interface IndexedRequest<TReq = { method: string; params: any[] }> {
  originalIndex: number;
  ref: TReq;
}

export interface RateLimiterFailedBatch {
  batchIndex: number;
  method: string;
  size: number;
  error: unknown;
}

export class RateLimiterBatchError extends Error {
  constructor(public readonly failedBatches: RateLimiterFailedBatch[]) {
    super(
      `RateLimiter failed ${failedBatches.length} scheduled batch(es): ` +
        failedBatches
          .map((failure) => {
            const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
            return `#${failure.batchIndex} method=${failure.method} size=${failure.size}: ${message}`;
          })
          .join('; ')
    );
    this.name = 'RateLimiterBatchError';
  }
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
 *   - Queues all chunks into the Scheduler so maxConcurrentRequests and pacing actually apply
 *   - Waits for all scheduled chunks with allSettled before surfacing transport-level failures
 *   - Preserves exact output order matching input order
 *   - Passes request objects by reference (no cloning)
 *   - Re-throws transport-level batch errors; item-level nulls handled inside batchRpcCall
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
      minTimeMsBetweenRequests: config.minTimeMsBetweenRequests ?? config.requestDelayMs ?? 0,
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

    const scheduledBatches = batches.map((batch, batchIndex) =>
      this.limiter.schedule(async () => {
        const plainRequests = batch.requests.map((ir) => ir.ref);
        const batchResults = await batchRpcCall(plainRequests);

        if (!Array.isArray(batchResults)) {
          return { batchIndex, method: batch.method, size: batch.requests.length };
        }

        for (let i = 0; i < batch.requests.length; i++) {
          const ir = batch.requests[i]!;
          results[ir.originalIndex] = i < batchResults.length ? (batchResults[i] as T | null) : null;
        }

        return { batchIndex, method: batch.method, size: batch.requests.length };
      })
    );

    const settled = await Promise.allSettled(scheduledBatches);
    const failedBatches: RateLimiterFailedBatch[] = [];

    for (let batchIndex = 0; batchIndex < settled.length; batchIndex++) {
      const result = settled[batchIndex]!;
      if (result.status === 'fulfilled') continue;

      const batch = batches[batchIndex]!;
      failedBatches.push({
        batchIndex,
        method: batch.method,
        size: batch.requests.length,
        error: result.reason,
      });
    }

    if (failedBatches.length > 0) {
      // Transport-level batch failures are not converted into partial null results.
      // Item-level RPC errors should already be represented by null entries from batchRpcCall.
      throw new RateLimiterBatchError(failedBatches);
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
