import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

/**
 * Simple Rate Limiter - only handles rate limiting and batching
 *
 * Key features:
 * - Splits requests into batches based on maxBatchSize
 * - Handles rate limiting and concurrency via Bottleneck
 * - Does NOT group by method - that's RPC provider's job
 * - Preserves exact request order
 */
export class RateLimiter {
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
   * Execute batch of requests with rate limiting
   * Simply splits into batches and calls batchRpcCall for each
   */
  async execute<T>(
    requests: Array<{ method: string; params: any[] }>,
    batchRpcCall: (calls: typeof requests) => Promise<(T | null)[]>
  ): Promise<(T | null)[]> {
    if (requests.length === 0) return [];

    // Simple batching without grouping by method
    const batches = this.createBatches(requests, this.config.maxBatchSize);
    const allResults: (T | null)[] = [];

    // Execute each batch with rate limiting
    for (const batch of batches) {
      try {
        const batchResults = await this.limiter.schedule(() => batchRpcCall(batch));

        if (!Array.isArray(batchResults)) {
          throw new Error('Invalid batch response: expected array');
        }

        // Handle partial responses - fill missing with null
        for (let i = 0; i < batch.length; i++) {
          const result = i < batchResults.length ? batchResults[i] ?? null : null;
          allResults.push(result);
        }
      } catch (error) {
        throw new Error(`Failed to execute batch: ${(error as any)?.message}`);
      }
    }

    return allResults;
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    if (batchSize <= 0) {
      throw new Error('Batch size must be greater than 0');
    }

    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  async stop(): Promise<void> {
    await this.limiter.stop({ dropWaitingJobs: true });
  }
}
