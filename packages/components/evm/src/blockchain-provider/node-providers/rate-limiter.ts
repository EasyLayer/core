import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

/**
 * Internal rate limiter for EVM providers
 * All requests are executed as batches, even single requests
 */
export class EvmRateLimiter {
  private limiter: Bottleneck;
  private config: Required<RateLimits>;

  constructor(config: RateLimits = {}) {
    this.config = {
      maxConcurrentRequests: config.maxConcurrentRequests ?? 1,
      maxBatchSize: config.maxBatchSize ?? 15,
      requestDelayMs: config.requestDelayMs ?? 1000,
    };

    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: this.config.requestDelayMs,
    });
  }

  /**
   * Execute all requests as batches
   * Groups by method and splits into batches based on maxBatchSize
   * Bottleneck handles all scheduling and concurrency
   */
  async execute<T>(
    requests: Array<{ method: string; params: any[] }>,
    batchCall: (calls: typeof requests) => Promise<T[]>
  ): Promise<T[]> {
    if (requests.length === 0) return [];

    // Group requests by method
    const methodGroups = new Map<string, Array<{ params: any[]; index: number }>>();

    requests.forEach((request, index) => {
      if (!methodGroups.has(request.method)) {
        methodGroups.set(request.method, []);
      }
      methodGroups.get(request.method)!.push({ params: request.params, index });
    });

    const results: T[] = new Array(requests.length);
    const allBatches: Array<{ batch: Array<{ params: any[]; index: number }>; method: string }> = [];

    // Collect all batches
    for (const [method, items] of methodGroups) {
      const batches = this.createBatches(items, this.config.maxBatchSize);
      batches.forEach((batch) => {
        allBatches.push({ batch, method });
      });
    }

    // Execute all batches through bottleneck sequentially
    for (const { batch, method } of allBatches) {
      const batchCalls = batch.map((item) => ({ method, params: item.params }));
      const batchResults = await this.limiter.schedule(() => batchCall(batchCalls));

      batch.forEach((item, i) => {
        results[item.index] = batchResults[i]!;
      });
    }

    return results;
  }

  /**
   * Split items into batches based on maxBatchSize
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Stop the bottleneck limiter
   */
  async stop(): Promise<void> {
    await this.limiter.stop({ dropWaitingJobs: true });
  }
}
