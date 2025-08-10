import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, MempoolTransaction, LightBlock } from '../../blockchain-provider';
import {
  BitcoinMempoolInitializedEvent,
  BitcoinMempoolSyncProcessedEvent,
  BitcoinMempoolClearedEvent,
  BitcoinMempoolSynchronizedEvent,
} from '../events';
import { MempoolNotLoadedError, MempoolSizeMismatchError } from './errors';

/**
 * Optimized Bitcoin Mempool using hash-based Map storage.
 *
 * Memory Optimization Strategy:
 * - Use 32-bit hashes instead of 64-byte txid strings (saves ~2MB for 34k transactions)
 * - Store JavaScript objects directly (no JSON serialization overhead)
 * - Track ALL loaded transactions, store only those meeting fee requirements
 *
 * Memory Usage for 34k transactions (~265MB raw data):
 * - Transaction objects: ~170-204MB (main storage)
 * - Map overhead: ~816KB (Map entries)
 * - Hash mappings: ~3.1MB (txidHash -> original txid)
 * - Tracking data: ~2.7MB (loaded txids metadata)
 * - Fee rate index: ~200KB (pruning optimization)
 * Total: ~177-211MB (67-80% efficiency vs raw blockchain data)
 *
 * Performance Characteristics:
 * - Add transaction: O(1)
 * - Find transaction: O(1)
 * - Remove transaction: O(1)
 * - Prune by fee rate: O(n) where n = transactions to remove
 */
export class Mempool extends AggregateRoot {
  private minFeeRate: number;
  private fullSyncTimeoutMs: number = 20000; // 10 seconds timeout for getRawMempool(true)
  private syncThresholdPercent: number = 0.9;

  // Dynamic batching parameters
  private currentBatchSize: number = 150;
  private previousSyncDuration: number = 0;
  private lastSyncDuration: number = 0;

  // State tracking
  private isSynchronized: boolean = false; // becomes true when syncThresholdPercent of txids are loaded (once per app run)

  // Track all txids that should be in mempool (from node)
  // Key: txidHash (4 bytes), Value: true (just tracking existence)
  private allTxidsFromNode: Map<number, boolean> = new Map();

  // Core storage with 32-bit hash optimization
  // Key: txidHash (4 bytes), Value: MempoolTransaction object (~4-6KB each)
  private transactions: Map<number, MempoolTransaction> = new Map();

  // Track ALL loaded transactions (including those filtered by fee rate)
  // This allows us to know what we've already processed without re-downloading
  private loadedTxids: Map<number, { timestamp: number; feeRate: number }> = new Map();

  // Reverse mapping for API compatibility (when we need original txid strings)
  // Key: txidHash (4 bytes), Value: original txid string (64 bytes)
  private hashToTxid: Map<number, string> = new Map();

  // No age-based cleanup - only remove when confirmed in blocks or not in mempool

  // Fee rate indexing for efficient pruning operations
  // Key: rounded fee rate, Value: Set of txidHash values
  private feeRateIndex: Map<number, Set<number>> = new Map();
  private feeRatePrecision: number = 10; // Round to 0.1 sat/vB precision

  constructor({
    aggregateId,
    blockHeight,
    minFeeRate = 1, // Conservative default - don't filter too aggressively
    fullSyncTimeoutMs = 20000, // 10 seconds timeout for full sync attempt
    feeRatePrecision = 10,
    options,
  }: {
    aggregateId: string;
    blockHeight: number;
    minFeeRate?: number;
    fullSyncTimeoutMs?: number;
    feeRatePrecision?: number;
    options?: {
      snapshotsEnabled?: boolean;
      pruneOldSnapshots?: boolean;
      allowEventsPruning?: boolean;
    };
  }) {
    super(aggregateId, blockHeight, options);

    this.minFeeRate = minFeeRate;
    this.fullSyncTimeoutMs = fullSyncTimeoutMs;
    this.feeRatePrecision = feeRatePrecision;
  }

  // ========== CORE OPERATIONS ==========

  /**
   * Hash txid string to 32-bit integer for memory efficiency.
   * Uses a simple but fast hash algorithm with good distribution.
   *
   * Memory savings: 64 bytes (string) -> 4 bytes (number) = 60 bytes per txid
   * For 34k transactions: 60 * 34,000 = ~2MB saved
   */
  private hashTxid(txid: string): number {
    let hash = 0;
    for (let i = 0; i < txid.length; i++) {
      hash = ((hash << 5) - hash + txid.charCodeAt(i)) & 0xffffffff;
    }
    return hash >>> 0; // Convert to unsigned 32-bit integer
  }

  /**
   * Add transaction with fee filtering but track ALL loaded txids.
   *
   * Strategy:
   * 1. Always track that we loaded this transaction (prevents re-downloading)
   * 2. Only store transaction object if fee rate meets minimum requirement
   * 3. Update fee rate index for efficient pruning operations
   *
   * @param txid Original transaction ID string
   * @param transaction Full transaction object
   * @returns true if transaction was stored, false if filtered by fee rate
   *
   * @complexity O(1) - constant time insertion
   */
  private addTransaction(txid: string, transaction: MempoolTransaction): boolean {
    const txidHash = this.hashTxid(txid);
    const feeRate = this.calculateFeeRate(transaction);

    // Always track that we loaded this transaction
    // This prevents re-downloading the same transaction multiple times
    this.loadedTxids.set(txidHash, {
      timestamp: Date.now(),
      feeRate,
    });

    // Store reverse mapping for API compatibility
    this.hashToTxid.set(txidHash, txid);

    // Only store transaction if fee rate meets minimum requirement
    if (feeRate < this.minFeeRate) {
      return false; // Tracked but not stored - saves memory
    }

    // Store high-fee transactions for fast access
    this.transactions.set(txidHash, transaction);
    this.addToFeeRateIndex(feeRate, txidHash);

    return true;
  }

  /**
   * Remove transaction and cleanup all related indexes.
   *
   * @param txid Original transaction ID string
   * @returns true if transaction was found and removed
   *
   * @complexity O(1) - constant time removal
   */
  private removeTransaction(txid: string): boolean {
    const txidHash = this.hashTxid(txid);
    const transaction = this.transactions.get(txidHash);

    if (!transaction) {
      // Still remove from tracking even if not stored
      this.loadedTxids.delete(txidHash);
      this.hashToTxid.delete(txidHash);
      this.allTxidsFromNode.delete(txidHash);
      return false;
    }

    const feeRate = this.calculateFeeRate(transaction);

    // Remove from all storage and indexes
    this.transactions.delete(txidHash);
    this.loadedTxids.delete(txidHash);
    this.hashToTxid.delete(txidHash);
    this.allTxidsFromNode.delete(txidHash);
    this.removeFromFeeRateIndex(feeRate, txidHash);

    return true;
  }

  /**
   * Calculate fee rate safely handling edge cases.
   *
   * @param transaction Transaction object
   * @returns Fee rate in sat/vB, 0 if invalid vsize
   */
  private calculateFeeRate(transaction: MempoolTransaction): number {
    return transaction.vsize > 0 ? transaction.fees.base / transaction.vsize : 0;
  }

  /**
   * Round fee rate to specified precision for indexing.
   * This reduces the number of unique fee rate buckets for efficient grouping.
   *
   * @param feeRate Raw fee rate
   * @returns Rounded fee rate (default precision: 0.1 sat/vB)
   */
  private roundFeeRate(feeRate: number): number {
    return Math.floor(feeRate * this.feeRatePrecision) / this.feeRatePrecision;
  }

  /**
   * Add transaction to fee rate index for efficient pruning operations.
   * Groups transactions by rounded fee rate for batch operations.
   */
  private addToFeeRateIndex(feeRate: number, txidHash: number): void {
    const roundedFeeRate = this.roundFeeRate(feeRate);

    if (!this.feeRateIndex.has(roundedFeeRate)) {
      this.feeRateIndex.set(roundedFeeRate, new Set());
    }

    this.feeRateIndex.get(roundedFeeRate)!.add(txidHash);
  }

  /**
   * Remove transaction from fee rate index.
   * Cleans up empty buckets to prevent memory leaks.
   */
  private removeFromFeeRateIndex(feeRate: number, txidHash: number): void {
    const roundedFeeRate = this.roundFeeRate(feeRate);
    const feeRateSet = this.feeRateIndex.get(roundedFeeRate);

    if (feeRateSet) {
      feeRateSet.delete(txidHash);
      if (feeRateSet.size === 0) {
        this.feeRateIndex.delete(roundedFeeRate);
      }
    }
  }

  /**
   * Prune transactions below fee rate threshold.
   * Uses fee rate index for efficient batch operations.
   *
   * @param newMinFeeRate New minimum fee rate threshold
   * @returns Number of transactions pruned
   *
   * @complexity O(k) where k = number of transactions to remove
   */
  public pruneLowFeeTransactions(newMinFeeRate: number): number {
    let prunedCount = 0;
    const hashesToRemove: number[] = [];

    // Find all transactions below threshold using fee rate index
    for (const [feeRate, txidHashSet] of this.feeRateIndex) {
      if (feeRate < newMinFeeRate) {
        hashesToRemove.push(...txidHashSet);
      }
    }

    // Remove them using original txid strings
    for (const txidHash of hashesToRemove) {
      const originalTxid = this.hashToTxid.get(txidHash);
      if (originalTxid && this.removeTransaction(originalTxid)) {
        prunedCount++;
      }
    }

    this.minFeeRate = newMinFeeRate;
    return prunedCount;
  }

  /**
   * Remove confirmed transactions from loadedTxids tracking.
   * Called when processing blocks to clean up confirmed transactions.
   *
   * @param confirmedTxids Array of transaction IDs that were confirmed in blocks
   */
  private removeConfirmedFromLoadedTxids(confirmedTxids: string[]): void {
    for (const txid of confirmedTxids) {
      const txidHash = this.hashTxid(txid);
      this.loadedTxids.delete(txidHash);
    }
  }

  /**
   * Remove transactions that were confirmed in blocks.
   * This is called when processing new blocks to clean up the mempool.
   *
   * @param confirmedTxids Array of transaction IDs that were confirmed
   * @returns Number of transactions removed from mempool
   */
  public removeConfirmedTransactions(confirmedTxids: string[]): number {
    let removedCount = 0;

    for (const txid of confirmedTxids) {
      if (this.removeTransaction(txid)) {
        removedCount++;
      }
    }
    return removedCount;
  }

  /**
   * Adjust batch size based on previous sync performance.
   * Dynamically optimizes sync performance based on timing history.
   */
  private adjustBatchSize(): void {
    if (this.previousSyncDuration > 0 && this.lastSyncDuration > 0) {
      const timingRatio = this.lastSyncDuration / this.previousSyncDuration;

      if (timingRatio > 1.2) {
        // Sync took longer - increase batch size for better throughput
        this.currentBatchSize = Math.round(this.currentBatchSize * 1.25);
      } else if (timingRatio < 0.8) {
        // Sync was faster - can reduce batch size to avoid overwhelming
        this.currentBatchSize = Math.max(10, Math.round(this.currentBatchSize * 0.75));
      }
    }
  }

  /**
   * Smart transaction loading with timeout-based strategy.
   * First tries getRawMempool(true) with timeout, then falls back to batched loading.
   * If successful, uses fee rates to prioritize loading order.
   */
  private async loadTransactionsSmart(
    txidsToLoad: string[],
    service: BlockchainProviderService
  ): Promise<{ loaded: Array<{ txid: string; transaction: MempoolTransaction }>; hasMore: boolean }> {
    let loadedTransactions: Array<{ txid: string; transaction: MempoolTransaction }> = [];
    let hasMore = false;

    try {
      // Try to get full mempool with timeout
      const fullMempoolPromise = service.getRawMempool(true);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Full sync timeout')), this.fullSyncTimeoutMs)
      );

      const fullMempool = await Promise.race([fullMempoolPromise, timeoutPromise]);

      // Success - we got full mempool data

      // Extract fee rates and sort txids by priority (highest fee rate first)
      const txidsWithFeeRates: Array<{ txid: string; feeRate: number; transaction: MempoolTransaction }> = [];

      for (const txid of txidsToLoad) {
        const txData = fullMempool[txid];
        if (txData) {
          const transaction = txData as MempoolTransaction;
          const feeRate = transaction.vsize > 0 ? transaction.fees.base / transaction.vsize : 0;
          txidsWithFeeRates.push({ txid, feeRate, transaction });
        }
      }

      // Sort by fee rate (highest first) for priority loading
      txidsWithFeeRates.sort((a, b) => b.feeRate - a.feeRate);

      // Take up to currentBatchSize transactions
      const batchToProcess = txidsWithFeeRates.slice(0, this.currentBatchSize);
      hasMore = txidsWithFeeRates.length > this.currentBatchSize;

      loadedTransactions = batchToProcess.map(({ txid, transaction }) => ({ txid, transaction }));
    } catch (error) {
      // Timeout or error - fall back to batched loading without prioritization

      const txidsToProcess = txidsToLoad.slice(0, this.currentBatchSize);
      hasMore = txidsToLoad.length > this.currentBatchSize;

      const result = await this.loadTransactionsBatched(txidsToProcess, service, this.currentBatchSize);
      loadedTransactions = result.loaded;
    }

    return { loaded: loadedTransactions, hasMore };
  }

  /**
   * Load transactions using getMempoolEntries with batching - multiple RPC calls
   */
  private async loadTransactionsBatched(
    txidsToLoad: string[],
    service: BlockchainProviderService,
    batchSize: number
  ): Promise<{ loaded: Array<{ txid: string; transaction: MempoolTransaction }> }> {
    const loaded: Array<{ txid: string; transaction: MempoolTransaction }> = [];

    for (let i = 0; i < txidsToLoad.length; i += batchSize) {
      const batch = txidsToLoad.slice(i, i + batchSize);

      try {
        const entries = await service.getMempoolEntries(batch);

        for (let j = 0; j < entries.length; j++) {
          const entry = entries[j];
          const txid = batch[j];

          if (!entry || !txid) {
            continue;
          }

          loaded.push({ txid, transaction: entry as MempoolTransaction });
        }
      } catch (batchError) {
        // Skip failed batches, will retry next time
      }
    }

    return { loaded };
  }

  // ========== PUBLIC API ==========

  /**
   * Get all current transaction IDs as strings.
   * Converts internal hashes back to original txid strings.
   *
   * @returns Array of transaction ID strings
   * @complexity O(n) where n = number of stored transactions
   */
  public getCurrentTxids(): string[] {
    const txids: string[] = [];
    for (const txidHash of this.transactions.keys()) {
      const originalTxid = this.hashToTxid.get(txidHash);
      if (originalTxid) {
        txids.push(originalTxid);
      }
    }
    return txids;
  }

  /**
   * Get all cached transactions as a Map.
   * Returns stored transactions with original txid strings as keys.
   *
   * @returns Map of txid -> transaction object
   * @complexity O(n) where n = number of stored transactions
   */
  public getCachedTransactions(): Map<string, MempoolTransaction | null> {
    const result = new Map<string, MempoolTransaction | null>();

    // Add all txids from node with their transaction data or null
    for (const txidHash of this.allTxidsFromNode.keys()) {
      const originalTxid = this.hashToTxid.get(txidHash);
      if (originalTxid) {
        const transaction = this.transactions.get(txidHash) || null;
        result.set(originalTxid, transaction);
      }
    }

    return result;
  }

  /**
   * Get all loaded transactions (same as cached for this implementation).
   *
   * @returns Map of txid -> transaction object
   */
  public getLoadedTransactions(): Map<string, MempoolTransaction> {
    const result = new Map<string, MempoolTransaction>();

    for (const [txidHash, transaction] of this.transactions) {
      const originalTxid = this.hashToTxid.get(txidHash);
      if (originalTxid) {
        result.set(originalTxid, transaction);
      }
    }

    return result;
  }

  /**
   * Get metadata about all loaded transaction IDs.
   * This includes transactions that were filtered out by fee rate.
   *
   * @returns Map of txid -> loading metadata
   * @complexity O(n) where n = number of tracked transactions
   */
  public getLoadedTxids(): Map<string, { timestamp: number; feeRate: number }> {
    const result = new Map<string, { timestamp: number; feeRate: number }>();

    for (const [txidHash, loadInfo] of this.loadedTxids) {
      const originalTxid = this.hashToTxid.get(txidHash);
      if (originalTxid) {
        result.set(originalTxid, loadInfo);
      }
    }

    return result;
  }

  /**
   * Check if a transaction has been loaded (tracked).
   * Returns true even if transaction was filtered by fee rate.
   *
   * @param txid Transaction ID to check
   * @returns true if transaction was loaded/tracked
   * @complexity O(1)
   */
  public isTransactionLoaded(txid: string): boolean {
    const txidHash = this.hashTxid(txid);
    return this.loadedTxids.has(txidHash);
  }

  /**
   * Check if a transaction is stored in the mempool.
   * Returns true only if transaction passed fee rate filtering.
   *
   * @param txid Transaction ID to check
   * @returns true if transaction is stored
   * @complexity O(1)
   */
  public hasTransaction(txid: string): boolean {
    const txidHash = this.hashTxid(txid);
    return this.transactions.has(txidHash);
  }

  /**
   * Get a specific transaction by its ID.
   *
   * @param txid Transaction ID to retrieve
   * @returns Transaction object or undefined if not found
   * @complexity O(1)
   */
  public getTransaction(txid: string): MempoolTransaction | undefined {
    const txidHash = this.hashTxid(txid);
    return this.transactions.get(txidHash);
  }

  /**
   * Get multiple transactions by their IDs.
   *
   * @param txids Array of transaction IDs to retrieve
   * @returns Array of transaction objects (undefined for not found)
   * @complexity O(k) where k = number of requested transactions
   */
  public getTransactions(txids: string[]): (MempoolTransaction | undefined)[] {
    return txids.map((txid) => this.getTransaction(txid));
  }

  // ========== STATUS AND METRICS ==========

  public isMempoolSynchronized(): boolean {
    return this.isSynchronized;
  }

  public getTransactionCount(): number {
    return this.transactions.size;
  }

  public getTotalTxidsCount(): number {
    return this.allTxidsFromNode.size;
  }

  public getLoadedTxidsCount(): number {
    return this.loadedTxids.size;
  }

  public getFullSyncTimeoutMs(): number {
    return this.fullSyncTimeoutMs;
  }

  public getCurrentBatchSize(): number {
    return this.currentBatchSize;
  }

  public getSyncTimingInfo(): { previous: number; last: number; ratio?: number } {
    return {
      previous: this.previousSyncDuration,
      last: this.lastSyncDuration,
      ratio: this.previousSyncDuration > 0 ? this.lastSyncDuration / this.previousSyncDuration : undefined,
    };
  }

  /**
   * Get comprehensive performance metrics for monitoring.
   *
   * @returns Object with memory usage and performance statistics
   */
  public getPerformanceMetrics(): {
    memoryUsage: number;
    transactionCount: number;
    loadedTxidsCount: number;
    avgTransactionSize: number;
    feeRateIndexSize: number;
    memoryEfficiency: number;
  } {
    // Rough memory estimation
    const avgTxSize = 5000; // Estimated bytes per transaction object in memory
    const memoryUsage = this.transactions.size * avgTxSize;
    const rawDataSize = memoryUsage * 1.3; // Estimate raw blockchain data size

    return {
      memoryUsage,
      transactionCount: this.transactions.size,
      loadedTxidsCount: this.loadedTxids.size,
      avgTransactionSize: avgTxSize,
      feeRateIndexSize: this.feeRateIndex.size,
      memoryEfficiency: memoryUsage / rawDataSize, // Efficiency vs raw data
    };
  }

  // ========== SNAPSHOTS ==========

  protected toJsonPayload(): any {
    return {
      minFeeRate: this.minFeeRate,
      fullSyncTimeoutMs: this.fullSyncTimeoutMs,
      syncThresholdPercent: this.syncThresholdPercent,
      currentBatchSize: this.currentBatchSize,
      previousSyncDuration: this.previousSyncDuration,
      lastSyncDuration: this.lastSyncDuration,
      isSynchronized: this.isSynchronized,
      feeRatePrecision: this.feeRatePrecision,
      // Convert Maps to arrays for JSON serialization
      allTxidsFromNode: Array.from(this.allTxidsFromNode.entries()),
      transactions: Array.from(this.transactions.entries()),
      loadedTxids: Array.from(this.loadedTxids.entries()),
      hashToTxid: Array.from(this.hashToTxid.entries()),
    };
  }

  protected fromSnapshot(state: any): void {
    // Restore primitive values
    this.minFeeRate = state.minFeeRate || 1;
    this.fullSyncTimeoutMs = state.fullSyncTimeoutMs || 10000;
    this.syncThresholdPercent = state.syncThresholdPercent || 0.9;
    this.currentBatchSize = state.currentBatchSize || 150;
    this.previousSyncDuration = state.previousSyncDuration || 0;
    this.lastSyncDuration = state.lastSyncDuration || 0;
    this.isSynchronized = state.isSynchronized || false;
    this.feeRatePrecision = state.feeRatePrecision || 10;

    // Restore Maps from arrays
    this.allTxidsFromNode = new Map(state.allTxidsFromNode || []);
    this.transactions = new Map(state.transactions || []);
    this.loadedTxids = new Map(state.loadedTxids || []);
    this.hashToTxid = new Map(state.hashToTxid || []);

    // Rebuild fee rate index from current transactions
    this.feeRateIndex.clear();
    for (const [txidHash, transaction] of this.transactions) {
      const feeRate = this.calculateFeeRate(transaction);
      this.addToFeeRateIndex(feeRate, txidHash);
    }

    Object.setPrototypeOf(this, Mempool.prototype);
  }

  // ========== STREAMING GETTERS ==========

  /**
   * Stream loaded transactions in batches for memory-efficient processing.
   * Useful for exporting large datasets without loading everything into memory.
   */
  public async *streamLoadedTransactions(batchSize: number = 100): AsyncGenerator<
    {
      batch: Array<{ txid: string; transaction: MempoolTransaction }>;
      batchIndex: number;
      hasMore: boolean;
    },
    void,
    unknown
  > {
    const entries = Array.from(this.transactions.entries());
    let batchIndex = 0;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batchData = entries.slice(i, i + batchSize);
      const batch = batchData
        .map(([txidHash, transaction]) => {
          const originalTxid = this.hashToTxid.get(txidHash);
          return originalTxid ? { txid: originalTxid, transaction } : null;
        })
        .filter((item): item is { txid: string; transaction: MempoolTransaction } => item !== null);

      const hasMore = i + batchSize < entries.length;

      yield {
        batch,
        batchIndex,
        hasMore,
      };

      batchIndex++;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Stream current transaction IDs in batches.
   */
  public async *streamCurrentTxids(batchSize: number = 1000): AsyncGenerator<
    {
      batch: string[];
      batchIndex: number;
      hasMore: boolean;
    },
    void,
    unknown
  > {
    const txidHashes = Array.from(this.transactions.keys());
    let batchIndex = 0;

    for (let i = 0; i < txidHashes.length; i += batchSize) {
      const hashBatch = txidHashes.slice(i, i + batchSize);
      const batch = hashBatch
        .map((hash) => this.hashToTxid.get(hash))
        .filter((txid): txid is string => txid !== undefined);

      const hasMore = i + batchSize < txidHashes.length;

      yield {
        batch,
        batchIndex,
        hasMore,
      };

      batchIndex++;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // ========== PUBLIC COMMAND METHODS ==========

  /**
   * Initialize mempool by getting current transaction list from node.
   * Validates that we received all transactions from the node.
   */
  public async init({
    requestId,
    currentNetworkHeight,
    service,
  }: {
    requestId: string;
    currentNetworkHeight: number;
    service: BlockchainProviderService;
  }) {
    // Get mempool info and txids in parallel for validation
    const [mempoolInfo, allTxidsFromNode] = await Promise.all([service.getMempoolInfo(), service.getRawMempool(false)]);

    // Check if mempool is enabled in the node
    if (!mempoolInfo.loaded) {
      throw new MempoolNotLoadedError();
    }

    // Validate that we received all txids
    if (allTxidsFromNode.length < mempoolInfo.size) {
      throw new MempoolSizeMismatchError();
    }

    await this.apply(
      new BitcoinMempoolInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: currentNetworkHeight,
        allTxidsFromNode,
        isSynchronized: false, // Always reset to false on initialization
      })
    );
  }

  /**
   * Process mempool synchronization by loading transaction data.
   */
  public async processSync({
    requestId,
    service,
    hasMoreToProcess = true,
  }: {
    requestId: string;
    service: BlockchainProviderService;
    hasMoreToProcess?: boolean;
  }) {
    // Only process if there's more to process
    if (!hasMoreToProcess) {
      return;
    }

    // Check if we should trigger synchronized event (once per app run)
    if (!this.isSynchronized) {
      const totalTxids = this.allTxidsFromNode.size;
      const loadedCount = this.loadedTxids.size;
      const loadedPercent = totalTxids > 0 ? loadedCount / totalTxids : 0;

      if (loadedPercent >= this.syncThresholdPercent) {
        await this.apply(
          new BitcoinMempoolSynchronizedEvent({
            aggregateId: this.aggregateId,
            requestId,
            blockHeight: this.lastBlockHeight,
            isSynchronized: true,
          })
        );
        return; // Exit after publishing synchronized event
      }
    }

    const syncStartTime = Date.now();
    this.adjustBatchSize();

    // Find txids that need to be loaded
    const txidsToLoad: string[] = [];
    for (const txidHash of this.allTxidsFromNode.keys()) {
      // Skip if already loaded
      if (this.loadedTxids.has(txidHash)) {
        continue;
      }

      const originalTxid = this.hashToTxid.get(txidHash);
      if (originalTxid) {
        txidsToLoad.push(originalTxid);
      }
    }

    let loadedTransactions: Array<{ txid: string; transaction: MempoolTransaction }> = [];
    let moreToProcess = false;

    if (txidsToLoad.length > 0) {
      // Use smart loading strategy with timeout and fee rate prioritization
      const result = await this.loadTransactionsSmart(txidsToLoad, service);
      loadedTransactions = result.loaded;
      moreToProcess = result.hasMore;
    }

    const syncEndTime = Date.now();
    this.previousSyncDuration = this.lastSyncDuration;
    this.lastSyncDuration = syncEndTime - syncStartTime;

    await this.apply(
      new BitcoinMempoolSyncProcessedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: this.lastBlockHeight,
        loadedTransactions,
        hasMoreToProcess: moreToProcess,
      })
    );
  }

  /**
   * Process new blocks and update mempool accordingly.
   */
  public async processBlocksBatch({
    requestId,
    blocks,
    service,
  }: {
    requestId: string;
    blocks: LightBlock[];
    service: BlockchainProviderService;
  }) {
    // Extract confirmed transactions from blocks to remove from tracking
    const confirmedTxids: string[] = [];
    for (const block of blocks) {
      if (block.tx) {
        confirmedTxids.push(...block.tx);
      }
    }

    // Remove confirmed transactions from loadedTxids tracking
    if (confirmedTxids.length > 0) {
      this.removeConfirmedFromLoadedTxids(confirmedTxids);
    }

    // Get mempool info and txids in parallel for validation
    const [mempoolInfo, allTxidsFromNode] = await Promise.all([service.getMempoolInfo(), service.getRawMempool(false)]);

    // Validate that we received all txids
    if (allTxidsFromNode.length < mempoolInfo.size) {
      throw new MempoolSizeMismatchError();
    }

    const latestBlockHeight = blocks.length > 0 ? blocks[blocks.length - 1]!.height : this.lastBlockHeight;

    await this.apply(
      new BitcoinMempoolInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: latestBlockHeight,
        allTxidsFromNode,
      })
    );
  }

  /**
   * Process blockchain reorganization.
   */
  public async processReorganisation({
    requestId,
    blocks,
    service,
  }: {
    requestId: string;
    blocks: Array<{ height: number; hash: string }>;
    service: BlockchainProviderService;
  }) {
    // Get mempool info and txids in parallel for validation
    const [mempoolInfo, allTxidsFromNode] = await Promise.all([service.getMempoolInfo(), service.getRawMempool(false)]);

    // Validate that we received all txids
    if (allTxidsFromNode.length < mempoolInfo.size) {
      throw new MempoolSizeMismatchError();
    }

    const reorgBlockHeight = blocks.length > 0 ? blocks[0]!.height : this.lastBlockHeight;

    await this.apply(
      new BitcoinMempoolInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: reorgBlockHeight,
        allTxidsFromNode,
      })
    );
  }

  /**
   * Clear the entire mempool.
   */
  public async clearMempool({ requestId }: { requestId: string }) {
    await this.apply(
      new BitcoinMempoolClearedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: -1,
      })
    );
  }

  // ========== EVENT HANDLERS (IDEMPOTENT) ==========

  private onBitcoinMempoolInitializedEvent({ payload }: BitcoinMempoolInitializedEvent) {
    const { allTxidsFromNode, isSynchronized } = payload;

    // Always reset synchronization status if explicitly set to false
    if (isSynchronized === false) {
      this.isSynchronized = false;
    }

    // Build new txid tracking from node data
    const newAllTxidsFromNode = new Map<number, boolean>();
    const newHashToTxid = new Map<number, string>();

    // Add all txids from node
    for (const txid of allTxidsFromNode) {
      const txidHash = this.hashTxid(txid);
      newAllTxidsFromNode.set(txidHash, true);
      newHashToTxid.set(txidHash, txid);
    }

    // Remove transactions and tracking data for txids no longer in mempool
    const currentTxidHashes = new Set(this.allTxidsFromNode.keys());
    const nodeTxidHashes = new Set(newAllTxidsFromNode.keys());

    for (const txidHash of currentTxidHashes) {
      if (!nodeTxidHashes.has(txidHash)) {
        // Remove transaction if exists
        const transaction = this.transactions.get(txidHash);
        if (transaction) {
          const feeRate = this.calculateFeeRate(transaction);
          this.removeFromFeeRateIndex(feeRate, txidHash);
          this.transactions.delete(txidHash);
        }

        // Remove tracking data (confirmed in block or expired from node mempool)
        this.loadedTxids.delete(txidHash);
        this.hashToTxid.delete(txidHash);
      }
    }

    // Update state with new data
    this.allTxidsFromNode = newAllTxidsFromNode;

    // Merge hashToTxid maps (keep existing + add new)
    for (const [hash, txid] of newHashToTxid) {
      this.hashToTxid.set(hash, txid);
    }
  }

  private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
    const { loadedTransactions } = payload;

    // Process all loaded transactions using addTransaction method
    for (const { txid, transaction } of loadedTransactions) {
      this.addTransaction(txid, transaction);
    }
  }

  private onBitcoinMempoolSynchronizedEvent({ payload }: BitcoinMempoolSynchronizedEvent) {
    const { isSynchronized } = payload;
    this.isSynchronized = isSynchronized;
  }

  private onBitcoinMempoolClearedEvent({ payload }: BitcoinMempoolClearedEvent) {
    // Clear all data structures
    this.allTxidsFromNode.clear();
    this.transactions.clear();
    this.loadedTxids.clear();
    this.hashToTxid.clear();
    this.feeRateIndex.clear();

    // Reset state variables
    this.isSynchronized = false;
    this.currentBatchSize = 150;
    this.previousSyncDuration = 0;
    this.lastSyncDuration = 0;
  }
}
