import type { RateLimits } from '../providers/interfaces';

interface IndexedRequest<TReq = { method: string; params: any[] }> {
  originalIndex: number;
  ref: TReq;
}

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

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Scheduler stopped'));
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

  async stop(opts: { dropWaitingJobs?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (opts.dropWaitingJobs !== false) this.queue.length = 0;
    if (this.reservoirTimer !== null) clearInterval(this.reservoirTimer);
    this.reservoirTimer = null;
  }

  private drain(): void {
    if (this.stopped || this.queue.length === 0) return;
    if (this.running >= this.maxConcurrent) return;
    if (this.reservoirEnabled && this.reservoir <= 0) return;

    const elapsed = Date.now() - this.lastStartTime;
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

    if (this.running < this.maxConcurrent) this.drain();
  }
}

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
      reservoir: this.config.reservoir,
      reservoirRefreshInterval: this.config.reservoirRefreshInterval,
      reservoirRefreshAmount: this.config.reservoirRefreshAmount,
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

    const indexedRequests: IndexedRequest[] = requests.map((req, idx) => ({ originalIndex: idx, ref: req }));
    const methodGroups = new Map<string, IndexedRequest[]>();
    for (const ir of indexedRequests) {
      const group = methodGroups.get(ir.ref.method);
      if (group) group.push(ir);
      else methodGroups.set(ir.ref.method, [ir]);
    }

    const results: (T | null)[] = new Array(requests.length).fill(null);
    for (const group of methodGroups.values()) {
      for (let i = 0; i < group.length; i += this.config.maxBatchSize!) {
        const batch = group.slice(i, i + this.config.maxBatchSize!);
        const plainRequests = batch.map((ir) => ir.ref);
        const batchResults = await this.limiter.schedule(() => batchRpcCall(plainRequests));
        if (!Array.isArray(batchResults)) continue;
        for (let j = 0; j < batch.length; j += 1) {
          const ir = batch[j]!;
          results[ir.originalIndex] = j < batchResults.length ? (batchResults[j] as T | null) : null;
        }
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
