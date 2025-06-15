import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

/**
 * Proper QuickNode rate limiting strategy:
 * - Bottleneck: ONLY for parallel individual requests (handles concurrency + RPS)
 * - Batch requests: Simple sequential processing with await (no Bottleneck needed)
 * - maxBatchSize: 15 (100% of QuickNode 15 RPS limit for maximum efficiency)
 * - batchDelayMs: 1000ms delay between batches AND between concurrent requests
 */
export const DEFAULT_RATE_LIMITS: Required<RateLimits> = {
  maxRequestsPerSecond: 10,
  maxConcurrentRequests: 8,
  maxBatchSize: 15,
  batchDelayMs: 1000,
};

export class RateLimiter {
  private limiter: Bottleneck;
  private config: Required<RateLimits>;

  constructor(config: RateLimits = {}) {
    this.config = {
      maxRequestsPerSecond: config.maxRequestsPerSecond ?? DEFAULT_RATE_LIMITS.maxRequestsPerSecond,
      maxConcurrentRequests: config.maxConcurrentRequests ?? DEFAULT_RATE_LIMITS.maxConcurrentRequests,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_RATE_LIMITS.maxBatchSize,
      batchDelayMs: config.batchDelayMs ?? DEFAULT_RATE_LIMITS.batchDelayMs,
    };

    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond),
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });
  }

  /**
   * Execute single request with rate limiting
   */
  async executeRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return await this.limiter.schedule(requestFn);
  }

  /**
   * Execute multiple individual requests in parallel
   */
  async executeParallelRequests<T>(requestFns: Array<() => Promise<T>>): Promise<T[]> {
    if (requestFns.length === 0) {
      return [];
    }

    const promises = requestFns.map((requestFn) => this.executeRequest(requestFn));
    return await Promise.all(promises);
  }

  /**
   * Execute batch requests with strict sequential processing
   *
   * Strategy:
   * 1. Send batch (configurable size)
   * 2. Wait for complete response
   * 3. Wait configurable delay
   * 4. Send next batch
   */
  async executeBatchRequests<T>(items: any[], batchRequestFn: (batchItems: any[]) => Promise<T[]>): Promise<T[]> {
    if (items.length === 0) {
      return [];
    }

    const batches = this.createBatches(items, this.config.maxBatchSize);
    const results: T[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        const batchResults = await batchRequestFn(batch!);

        for (let j = 0; j < batchResults.length; j++) {
          results.push(batchResults[j]!);
        }

        if (i < batches.length - 1) {
          await this.delay(this.config.batchDelayMs);
        }
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          throw new Error(`Rate limit exceeded: ${error?.message || 'Unknown error'}`);
        }
        throw error;
      }
    }

    return results;
  }

  /**
   * Execute individual requests sequentially
   */
  async executeSequentialRequests<T>(requestFns: Array<() => Promise<T>>): Promise<T[]> {
    if (requestFns.length === 0) {
      return [];
    }

    const results: T[] = [];

    for (const requestFn of requestFns) {
      try {
        const result = await this.executeRequest(requestFn);
        results.push(result);
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          throw new Error(`Rate limit exceeded: ${error?.message || 'Unknown error'}`);
        }
        throw error;
      }
    }

    return results;
  }

  /**
   * Create batches from array
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if error is rate limit related
   */
  private isRateLimitError(error: any): boolean {
    if (!error) return false;

    const errorMessage = (error.message || '').toString().toLowerCase();
    const errorCode = error.code;

    const rateMessages = [
      'rate limit',
      'request limit',
      'too many requests',
      'calls per second',
      'quota exceeded',
      'throttled',
      '15/second request limit',
      'rps limit',
    ];

    const rateCodes = [-32007, 429, -32005, -32000];

    const hasRateMessage = rateMessages.some((msg) => errorMessage.includes(msg));
    const hasRateCode = errorCode !== undefined && rateCodes.includes(errorCode);

    return hasRateMessage || hasRateCode;
  }

  /**
   * Get rate limiter statistics
   */
  getStats() {
    return {
      individualRequests: {
        running: this.limiter.running(),
        queued: this.limiter.queued(),
        estimatedRPS: this.config.maxRequestsPerSecond,
      },
      batchRequests: {
        batchSize: this.config.maxBatchSize,
        rpsUsagePerBatch: `${this.config.maxBatchSize}/15 (100% RPS utilization)`,
        delayBetweenBatches: `${this.config.batchDelayMs}ms`,
        processingType: 'Sequential (no queue needed)',
      },
      config: { ...this.config },
      efficiency: {
        quickNodeLimit: '15 RPS',
        batchEfficiency: '100% utilization (15/15 RPS)',
        delayStrategy: `Configurable ${this.config.batchDelayMs}ms between batches`,
      },
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<RateLimits>): void {
    if (newConfig.maxRequestsPerSecond !== undefined) {
      this.config.maxRequestsPerSecond = newConfig.maxRequestsPerSecond;
    }
    if (newConfig.maxConcurrentRequests !== undefined) {
      this.config.maxConcurrentRequests = newConfig.maxConcurrentRequests;
    }
    if (newConfig.maxBatchSize !== undefined) {
      this.config.maxBatchSize = newConfig.maxBatchSize;
    }
    if (newConfig.batchDelayMs !== undefined) {
      this.config.batchDelayMs = newConfig.batchDelayMs;
    }

    this.limiter.stop();
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond),
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });
  }

  /**
   * Reset state
   */
  reset(): void {
    this.limiter.stop();

    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond),
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });
  }
}
