import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

/**
 * Default rate limit configuration based on QuickNode Free plan
 *
 * QuickNode Free plan limitations:
 * - 15 RPS (requests per second) limit
 * - 10,000,000 API Credits per month
 * - Each RPC call in a batch is counted as separate request for API credits
 * - Batch requests are sent as single HTTP request but counted individually
 *
 * Strategy:
 * - For batch requests: 1 batch per second with many RPC calls inside
 * - For parallel requests: up to 12 concurrent individual requests per second
 * - Batch helps with network efficiency but doesn't reduce API credit usage
 */
export const DEFAULT_RATE_LIMITS: Required<RateLimits> = {
  maxRequestsPerSecond: 10, // For parallel individual requests (stay under 15 RPS)
  maxConcurrentRequests: 10, // Allow parallel processing for individual requests
  maxBatchSize: 10, // Large batch size for batch requests (sent 1 per second)
};

export class RateLimiter {
  private limiter: Bottleneck; // For individual parallel requests
  private batchLimiter: Bottleneck; // For batch requests (1 per second)
  private config: Required<RateLimits>;

  constructor(config: RateLimits = {}) {
    // Merge config with defaults
    this.config = {
      maxRequestsPerSecond: config.maxRequestsPerSecond ?? DEFAULT_RATE_LIMITS.maxRequestsPerSecond,
      maxConcurrentRequests: config.maxConcurrentRequests ?? DEFAULT_RATE_LIMITS.maxConcurrentRequests,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_RATE_LIMITS.maxBatchSize,
    };

    // Configure Bottleneck for parallel individual requests (up to 15 RPS)
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond), // ~83ms for 12 RPS
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });

    // Configure separate Bottleneck for batch requests (1 per second)
    this.batchLimiter = new Bottleneck({
      maxConcurrent: 1, // Only 1 batch at a time
      minTime: 1000, // 1 second between batch requests
      reservoir: 1,
      reservoirRefreshAmount: 1,
      reservoirRefreshInterval: 1000,
    });
  }

  /**
   * Execute a single request with rate limiting (no retry)
   * Used for individual requests that can be parallelized up to 15 RPS
   */
  async executeRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return await this.limiter.schedule(requestFn);
  }

  /**
   * Execute multiple individual requests in parallel with rate limiting
   * Each request goes through individual rate limiter (up to 12 concurrent, ~83ms apart)
   * Use this for scenarios where you have individual API calls that can be parallelized
   *
   * Example: Getting single blocks, transactions, or receipts in parallel
   */
  async executeParallelRequests<T>(requestFns: Array<() => Promise<T>>): Promise<T[]> {
    if (requestFns.length === 0) {
      return [];
    }

    // Execute all requests in parallel through individual rate limiter
    const promises = requestFns.map((requestFn) => this.executeRequest(requestFn));
    return await Promise.all(promises);
  }

  /**
   * Execute JSON-RPC batch requests with proper rate limiting
   *
   * Important QuickNode behavior:
   * - Each batch = one HTTP request (good for network efficiency)
   * - BUT each RPC call inside batch counts toward 15 RPS limit
   * - AND each RPC call consumes API credits separately
   *
   * Strategy for batch requests:
   * - Use large batches (up to 50 RPC calls per batch)
   * - Send only 1 batch per second to avoid overwhelming the 15 RPS limit
   * - This allows efficient bulk operations while respecting rate limits
   *
   * Example: 100 transaction hashes
   * - Batch 1: 8 RPC calls → sent → wait 1 second
   * - Batch 2: 8 RPC calls → sent
   * Total: ~1 second for 100 calls using batching
   */
  async executeBatchRequests<T>(items: any[], batchRequestFn: (batchItems: any[]) => Promise<T[]>): Promise<T[]> {
    if (items.length === 0) {
      return [];
    }

    // Split items into large batches for efficient bulk processing
    const batches = this.createBatches(items, this.config.maxBatchSize);
    const results: T[] = [];

    // Send batches SEQUENTIALLY with 1 second delay using batch limiter
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        // One batch = one HTTP request through batch rate limiter (1 per second)
        const batchResults = await this.batchLimiter.schedule(() => batchRequestFn(batch!));
        results.push(...batchResults);
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          const rateLimitMessage =
            `Rate limit exceeded when processing batch ${i + 1}/${batches.length}. ` +
            `Batch size: ${batch!.length}. Original error: ${error?.message || 'Unknown error'}. ` +
            `QuickNode Free plan allows 15 RPS but counts each RPC call in batch separately. ` +
            `Current batch strategy: ${this.config.maxBatchSize} RPC calls per batch, 1 batch per second. ` +
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
            `QuickNode Free plan allows 15 RPS. ` +
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
   *
   * QuickNode returns specific error codes when rate limits are exceeded:
   * - Code -32007: Rate limit exceeded
   * - HTTP 429: Too many requests
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
      '15/second request limit', // QuickNode specific message
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
      individualRequests: {
        running: this.limiter.running(),
        queued: this.limiter.queued(),
      },
      batchRequests: {
        running: this.batchLimiter.running(),
        queued: this.batchLimiter.queued(),
      },
      config: { ...this.config },
    };
  }

  /**
   * Update configuration at runtime
   *
   * Useful for adjusting batch sizes and timing based on actual RPC provider performance
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

    // Recreate individual request limiter with new settings
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond),
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });

    // Batch limiter stays the same (always 1 per second)
  }

  /**
   * Reset state (useful for testing)
   */
  reset(): void {
    this.limiter.stop();
    this.batchLimiter.stop();

    // Recreate individual request limiter
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: Math.ceil(1000 / this.config.maxRequestsPerSecond),
      reservoir: this.config.maxRequestsPerSecond,
      reservoirRefreshAmount: this.config.maxRequestsPerSecond,
      reservoirRefreshInterval: 1000,
    });

    // Recreate batch limiter
    this.batchLimiter = new Bottleneck({
      maxConcurrent: 1,
      minTime: 1000,
      reservoir: 1,
      reservoirRefreshAmount: 1,
      reservoirRefreshInterval: 1000,
    });
  }
}
