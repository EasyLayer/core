import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

// Default rate limit configuration based on QuickNode Free plan (15 RPS)
export const DEFAULT_RATE_LIMITS: Required<RateLimits> = {
  maxRequestsPerSecond: 12, // Slightly below QuickNode Free plan limit (15 RPS) to have buffer
  maxConcurrentRequests: 10, // Allow more concurrent requests
  maxBatchSize: 25, // RPC batch size - how many items in one JSON-RPC batch call
};

// Hardcoded batch delay
const BATCH_DELAY = 50; // ms between batch requests

export class RateLimiter {
  private limiter: Bottleneck;
  private config: Required<RateLimits>;

  constructor(config: RateLimits = {}) {
    // Merge config with defaults
    this.config = {
      maxRequestsPerSecond: config.maxRequestsPerSecond ?? DEFAULT_RATE_LIMITS.maxRequestsPerSecond,
      maxConcurrentRequests: config.maxConcurrentRequests ?? DEFAULT_RATE_LIMITS.maxConcurrentRequests,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_RATE_LIMITS.maxBatchSize,
    };

    // Configure Bottleneck
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond), // Convert RPS to minTime
      reservoir: this.config.maxRequestsPerSecond, // Start with full reservoir
      reservoirRefreshAmount: this.config.maxRequestsPerSecond, // Refill amount
      reservoirRefreshInterval: 1000, // Refill every second
    });
  }

  /**
   * Execute a single request with rate limiting (no retry)
   */
  async executeRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return await this.limiter.schedule(requestFn);
  }

  /**
   * Execute JSON-RPC batch requests with proper rate limiting
   * Each batch = one HTTP request with multiple RPC calls inside
   */
  async executeBatchRequests<T>(items: any[], batchRequestFn: (batchItems: any[]) => Promise<T[]>): Promise<T[]> {
    if (items.length === 0) {
      return [];
    }

    // Split items into batches by maxBatchSize (this is JSON-RPC batch size)
    const batches = this.createBatches(items, this.config.maxBatchSize);
    const results: T[] = [];

    // Send batches SEQUENTIALLY with rate limiting
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        // One batch = one HTTP request through rate limiter
        const batchResults = await this.executeRequest(() => batchRequestFn(batch!));
        results.push(...batchResults);

        // Delay between batches (except last one)
        if (i < batches.length - 1 && BATCH_DELAY > 0) {
          await this.delay(BATCH_DELAY);
        }
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          const rateLimitMessage =
            `Rate limit exceeded when processing batch ${i + 1}/${batches.length}. ` +
            `Batch size: ${batch!.length}. Original error: ${error?.message || 'Unknown error'}. ` +
            `Consider: 1) Reducing batch size, 2) Upgrading RPC plan.`;
          throw new Error(rateLimitMessage);
        }
        throw error;
      }
    }

    return results;
  }

  /**
   * Execute individual requests sequentially with rate limiting
   * Used when there's no batching capability
   */
  async executeSequentialRequests<T>(requestFns: Array<() => Promise<T>>): Promise<T[]> {
    if (requestFns.length === 0) {
      return [];
    }

    const results: T[] = [];

    // Send requests SEQUENTIALLY through rate limiter
    for (const requestFn of requestFns) {
      try {
        const result = await this.executeRequest(requestFn);
        results.push(result);
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          const rateLimitMessage =
            `Rate limit exceeded during sequential request. ` +
            `Progress: ${results.length}/${requestFns.length}. ` +
            `Original error: ${error?.message || 'Unknown error'}. ` +
            `Consider: 1) Reducing request rate, 2) Upgrading RPC plan.`;
          throw new Error(rateLimitMessage);
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

    // Rate limit indicators
    const rateMessages = [
      'rate limit',
      'request limit',
      'too many requests',
      'calls per second',
      'quota exceeded',
      'throttled',
    ];

    const rateCodes = [
      -32007, // QuickNode rate limit code
      429, // HTTP rate limit code
      -32005, // Request limit exceeded
      -32000, // Generic server error (sometimes used for rate limiting)
    ];

    // Check indicators
    const hasRateMessage = rateMessages.some((msg) => errorMessage.includes(msg));
    const hasRateCode = errorCode !== undefined && rateCodes.includes(errorCode);

    return hasRateMessage || hasRateCode;
  }

  /**
   * Get rate limiter statistics
   */
  getStats() {
    return {
      running: this.limiter.running(),
      queued: this.limiter.queued(),
      config: { ...this.config },
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig: Partial<RateLimits>): void {
    // Update internal config
    if (newConfig.maxRequestsPerSecond !== undefined) {
      this.config.maxRequestsPerSecond = newConfig.maxRequestsPerSecond;
    }
    if (newConfig.maxConcurrentRequests !== undefined) {
      this.config.maxConcurrentRequests = newConfig.maxConcurrentRequests;
    }
    if (newConfig.maxBatchSize !== undefined) {
      this.config.maxBatchSize = newConfig.maxBatchSize;
    }

    // Recreate Bottleneck with new settings
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond),
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });
  }

  /**
   * Reset state (useful for testing)
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
