import Bottleneck from 'bottleneck';
import type { RateLimits } from './interfaces';

/**
 * Internal wrapper that remembers the original position of each request
 * and keeps a reference to the original request object.
 */
interface IndexedRequest<TReq = { method: string; params: any[] }> {
  /** Absolute position in the caller-provided `requests` array */
  originalIndex: number;
  /** Original request object (passed through to `batchRpcCall` by reference) */
  ref: TReq;
}

/**
 * RateLimiter
 *
 * Purpose:
 * - Shape many JSON-RPC calls into method-homogeneous batches that respect sizing and pacing limits.
 * - Preserve the *exact* output order to match the original input order.
 * - Run batches through `bottleneck` so concurrency, pacing, and reservoir constraints are honored.
 *
 * Behavior:
 * - Requests are first grouped by `method` so a batch never mixes different methods.
 * - Each group is split into chunks of size `maxBatchSize`.
 * - Each chunk is scheduled via `Bottleneck#schedule`, which returns the batch result.
 * - Results are written back into a preallocated array at their original indices.
 * - If a batch returns fewer results than requested, remaining slots are filled with `null`.
 * - If a batch throws or returns a non-array value, affected slots stay `null`.
 *
 * Identity / allocations:
 * - The original request objects are forwarded *by reference* to `batchRpcCall` (no cloning),
 *   minimizing allocations and preserving object identity for downstream code and tests.
 */
export class RateLimiter {
  private limiter: Bottleneck;
  private config: RateLimits;

  constructor(config: RateLimits = {}) {
    this.config = {
      /** Maximum concurrently running *batches* */
      maxConcurrentRequests: config.maxConcurrentRequests ?? 1,
      /** Max number of calls inside a single batch (per method) */
      maxBatchSize: config.maxBatchSize ?? 15,
      /**
       * Minimum time gap between batches (ms).
       * Backwards-compat: `requestDelayMs` is used if `minTimeMsBetweenRequests` is not provided.
       */
      minTimeMsBetweenRequests: config.minTimeMsBetweenRequests ?? config.requestDelayMs ?? 1000,
    };

    // Bottleneck handles concurrency / pacing / reservoir policies.
    this.limiter = new Bottleneck({
      maxConcurrent: this.config.maxConcurrentRequests,
      minTime: this.config.minTimeMsBetweenRequests,
      reservoir: config.reservoir,
      reservoirRefreshInterval: config.reservoirRefreshInterval,
      reservoirRefreshAmount: config.reservoirRefreshAmount,
    });
  }

  /**
   * Execute a list of JSON-RPC calls in batches while preserving order.
   *
   * @param requests Array of JSON-RPC call descriptors, each `{ method, params }`.
   * @param batchRpcCall Function that sends a *single* batch to the provider and returns an array of results.
   *                     The result array is aligned with the input batch: `results[i]` corresponds to `batch[i]`.
   *                     Missing items are allowed (we will fill with `null`).
   *
   * @returns Array of results aligned with the original `requests` order. `null` marks missing/failed items.
   */
  async execute<T>(
    requests: Array<{ method: string; params: any[] }>,
    batchRpcCall: (calls: typeof requests) => Promise<(T | null)[]>
  ): Promise<(T | null)[]> {
    // Degenerate case: nothing to do.
    if (requests.length === 0) return [];

    // Defensive guard: avoid infinite loops and ill-defined behavior.
    if (!this.config.maxBatchSize || this.config.maxBatchSize <= 0) {
      throw new Error('Batch size must be greater than 0');
    }

    // Index requests once so we can always map results back to their original positions.
    const indexedRequests: IndexedRequest[] = requests.map((req, idx) => ({
      originalIndex: idx,
      ref: req,
    }));

    // Group by method so batches are homogeneous (better compatibility with many JSON-RPC servers).
    const methodGroups = new Map<string, IndexedRequest[]>();
    for (const ir of indexedRequests) {
      const key = ir.ref.method;
      const group = methodGroups.get(key);
      if (group) group.push(ir);
      else methodGroups.set(key, [ir]);
    }

    // Split each method group into sized chunks.
    const batches: { requests: IndexedRequest[]; method: string }[] = [];
    for (const [method, group] of methodGroups) {
      for (let i = 0; i < group.length; i += this.config.maxBatchSize) {
        const chunk = group.slice(i, i + this.config.maxBatchSize);
        if (chunk.length === 0) break;
        batches.push({ requests: chunk, method });
      }
    }

    // Pre-allocate result array and default to nulls.
    const results: (T | null)[] = new Array(requests.length).fill(null);

    // Schedule each batch through the limiter. Results are mapped back by original index.
    for (const batch of batches) {
      try {
        // Pass original objects by reference to avoid extra allocations and preserve identity.
        const plainRequests = batch.requests.map((ir) => ir.ref);

        const batchResults = await this.limiter.schedule(() => batchRpcCall(plainRequests));

        // If the provider returned something unexpected, keep `null`s for this batch.
        if (!Array.isArray(batchResults)) continue;

        // Copy aligned results back to their absolute positions; pad short responses with null.
        for (let i = 0; i < batch.requests.length; i++) {
          const ir = batch.requests[i]!;
          results[ir.originalIndex] = i < batchResults.length ? (batchResults[i] as T | null) : null;
        }
      } catch (err) {
        // Re-throw transport-level errors (connection refused, timeout, HTTP failures).
        // These must propagate so executeNetworkProviderMethod can trigger provider failover.
        // Item-level RPC errors (block not found, invalid hash) are already handled inside
        // batchCall() as per-item null values and never reach this catch block.
        throw err;
      }
    }

    return results;
  }

  /**
   * Stop the underlying limiter and drop any waiting jobs.
   * Useful in tests and on shutdown to avoid dangling timers/handles.
   */
  async stop(): Promise<void> {
    await this.limiter.stop({ dropWaitingJobs: true });
  }

  /** Return the effective configuration after defaults were applied. */
  getConfig(): RateLimits {
    return this.config;
  }
}
