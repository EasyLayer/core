import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

// Default rate limit configuration based on QuickNode Free plan (15 RPS)
export const DEFAULT_RATE_LIMITS: Required<RateLimits> = {
  maxRequestsPerSecond: 12, // Slightly below QuickNode Free plan limit (15 RPS) to have buffer
  maxConcurrentRequests: 10, // Allow more concurrent requests
  maxBatchSize: 25, // Increase batch size for better throughput
};

// Hardcoded retry configuration
const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 30000,
};

// Hardcoded batch delay
const BATCH_DELAY = 50; // ms

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
   * Execute a request with rate limiting and retry logic
   */
  async executeRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return this.executeWithRetry(requestFn);
  }

  /**
   * Execute multiple requests in batches with rate limiting
   */
  async executeBatchRequests<T>(requestFns: Array<() => Promise<T>>): Promise<T[]> {
    if (requestFns.length === 0) {
      return [];
    }

    // Split into batches
    const batches = this.createBatches(requestFns, this.config.maxBatchSize);
    const results: T[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        // Execute batch with rate limiting
        const batchPromises = batch!.map((fn) => this.executeRequest(fn));
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Add delay between batches (except for the last batch)
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
   * Execute request with retry logic
   */
  private async executeWithRetry<T>(requestFn: () => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      try {
        // Use Bottleneck to schedule the request
        return await this.limiter.schedule(requestFn);
      } catch (error: any) {
        lastError = error;

        // Don't retry if it's not a rate limit error and it's not the first attempt
        if (!this.isRateLimitError(error) && attempt > 1) {
          throw error;
        }

        // Don't retry on the last attempt
        if (attempt === RETRY_CONFIG.maxAttempts) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
          RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
          RETRY_CONFIG.maxDelay
        );

        await this.delay(delay);
      }
    }

    throw lastError;
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
