import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, MempoolTransaction } from '../../blockchain-provider';
import {
  BitcoinMempoolInitializedEvent,
  BitcoinMempoolSyncProcessedEvent,
  BitcoinMempoolSynchronizedEvent,
  BitcoinMempoolClearedEvent,
} from '../events';

/**
 * Bitcoin Mempool Aggregate
 *
 * Storage Collections:
 * 1. cachedTransactions: Map<txid, MempoolTransaction | null> - main transaction storage and txid tracking
 *    - null value = txid exists in node mempool but not loaded yet
 *    - MempoolTransaction = loaded transaction data
 *    - missing key = txid not in node mempool
 *
 * 2. feeRateIndex: Map<feeRate, Set<txid>> - fast lookup index for pruning by fee rate
 *
 * 3. loadedTxids: Map<txid, {timestamp, feeRate}> - tracks all attempted loads to avoid re-downloading
 *
 * Pruning Strategy:
 * - Only by fee rate: transactions below minFeeRate are stored as null after loading
 * - Selection criteria: LOWEST fee rate transactions removed first
 * - Uses feeRate index for O(1) lookup by fee level
 *
 * Synchronization Logic:
 * - isSynchronized = false initially and after each init/block processing
 * - Becomes true when 90% of current txids are loaded (triggers BitcoinMempoolSynchronizedEvent once per app run)
 * - Used to optimize processing cycles
 */
export class Mempool extends AggregateRoot {
  private minFeeRate: number; // sat/vB (satoshi per virtual byte): 1=very low, 10=low, 50=medium, 200+=high priority
  private fullSyncThreshold: number; // if txids < this, use getRawMempool(true)
  private syncThresholdPercent: number = 0.9; // 90% loaded = synchronized

  // Dynamic batching parameters
  private currentBatchSize: number = 150; // initial batch size (1.5MB / 10KB)
  private previousSyncDuration: number = 0; // previous processSync duration in ms
  private lastSyncDuration: number = 0; // last processSync duration in ms

  // State tracking
  private isSynchronized: boolean = false; // becomes true when 90% of txids are loaded (once per app run)

  // Main collections
  private cachedTransactions = new Map<string, MempoolTransaction | null>(); // txid -> full transaction data OR null if not loaded yet
  private feeRateIndex = new Map<number, Set<string>>(); // feeRate -> Set of txids (for fast pruning)

  // Tracking which txids we've attempted to load to avoid re-downloading
  // Cleared when: 1) transaction confirmed in block, 2) transaction expired from node mempool, 3) periodic cleanup (24h)
  private loadedTxids = new Map<string, { timestamp: number; feeRate: number }>(); // txid -> load info
  private loadedTxidsMaxAge = 24 * 60 * 60 * 1000; // 24 hours - clean up old entries

  constructor({
    aggregateId,
    blockHeight,
    minFeeRate = 100,
    fullSyncThreshold = 10000,
    options,
  }: {
    aggregateId: string;
    blockHeight: number;
    minFeeRate?: number;
    fullSyncThreshold?: number;
    options?: {
      snapshotsEnabled?: boolean;
      pruneOldSnapshots?: boolean;
      allowEventsPruning?: boolean;
    };
  }) {
    super(aggregateId, blockHeight, options);

    this.minFeeRate = minFeeRate;
    this.fullSyncThreshold = fullSyncThreshold;
  }

  // ===== GETTERS =====

  /**
   * Gets all transaction IDs currently tracked in mempool
   * Complexity: O(n) where n = number of tracked transactions
   */
  public getCurrentTxids(): string[] {
    return Array.from(this.cachedTransactions.keys());
  }

  /**
   * Gets copy of all cached transactions (loaded and unloaded)
   * Complexity: O(n) where n = number of tracked transactions
   */
  public getCachedTransactions(): Map<string, MempoolTransaction | null> {
    return new Map(this.cachedTransactions);
  }

  /**
   * Gets only fully loaded transactions (excludes null placeholders)
   * Complexity: O(n) where n = number of tracked transactions
   */
  public getLoadedTransactions(): Map<string, MempoolTransaction> {
    const result = new Map<string, MempoolTransaction>();
    for (const [txid, tx] of this.cachedTransactions) {
      if (tx !== null) {
        result.set(txid, tx);
      }
    }
    return result;
  }

  /**
   * Gets tracking info for all attempted loads
   * Complexity: O(n) where n = number of attempted loads
   */
  public getLoadedTxids(): Map<string, { timestamp: number; feeRate: number }> {
    return new Map(this.loadedTxids);
  }

  /**
   * Checks if transaction was previously loaded (regardless of fee rate)
   * Complexity: O(1)
   */
  public isTransactionLoaded(txid: string): boolean {
    return this.loadedTxids.has(txid);
  }

  /**
   * Checks if transaction is fully loaded and available
   * Complexity: O(1)
   */
  public hasTransaction(txid: string): boolean {
    const tx = this.cachedTransactions.get(txid);
    return tx !== undefined && tx !== null;
  }

  /**
   * Gets mempool synchronization status
   * Complexity: O(1)
   */
  public isMempoolSynchronized(): boolean {
    return this.isSynchronized;
  }

  /**
   * Counts fully loaded transactions
   * Complexity: O(n) where n = number of tracked transactions
   */
  public getTransactionCount(): number {
    let count = 0;
    for (const tx of this.cachedTransactions.values()) {
      if (tx !== null) count++;
    }
    return count;
  }

  /**
   * Gets total number of tracked transaction IDs
   * Complexity: O(1)
   */
  public getTotalTxidsCount(): number {
    return this.cachedTransactions.size;
  }

  /**
   * Gets threshold for using full sync vs batched loading
   * Complexity: O(1)
   */
  public getFullSyncThreshold(): number {
    return this.fullSyncThreshold;
  }

  /**
   * Gets current dynamic batch size
   * Complexity: O(1)
   */
  public getCurrentBatchSize(): number {
    return this.currentBatchSize;
  }

  /**
   * Gets performance timing information for batch size adjustment
   * Complexity: O(1)
   */
  public getSyncTimingInfo(): { previous: number; last: number; ratio?: number } {
    return {
      previous: this.previousSyncDuration,
      last: this.lastSyncDuration,
      ratio: this.previousSyncDuration > 0 ? this.lastSyncDuration / this.previousSyncDuration : undefined,
    };
  }

  // ===== SNAPSHOTS =====

  protected toJsonPayload(): any {
    return {
      minFeeRate: this.minFeeRate,
      fullSyncThreshold: this.fullSyncThreshold,
      syncThresholdPercent: this.syncThresholdPercent,
      currentBatchSize: this.currentBatchSize,
      previousSyncDuration: this.previousSyncDuration,
      lastSyncDuration: this.lastSyncDuration,
      isSynchronized: this.isSynchronized,
      cachedTransactions: Array.from(this.cachedTransactions.entries()),
      loadedTxids: Array.from(this.loadedTxids.entries()),
    };
  }

  protected fromSnapshot(state: any): void {
    this.minFeeRate = state.minFeeRate || 100;
    this.fullSyncThreshold = state.fullSyncThreshold || 10000;
    this.syncThresholdPercent = state.syncThresholdPercent || 0.9;
    this.currentBatchSize = state.currentBatchSize || 150;
    this.previousSyncDuration = state.previousSyncDuration || 0;
    this.lastSyncDuration = state.lastSyncDuration || 0;
    this.isSynchronized = state.isSynchronized || false;

    this.cachedTransactions = new Map(state.cachedTransactions || []);
    this.loadedTxids = new Map(state.loadedTxids || []);

    // Rebuild fee rate index from cached transactions (only loaded ones)
    this.feeRateIndex.clear();

    for (const [txid, transaction] of this.cachedTransactions) {
      if (transaction !== null) {
        this.addTransactionToFeeRateIndex(txid, transaction);
      }
    }

    Object.setPrototypeOf(this, Mempool.prototype);
  }

  // ===== STREAMING GETTERS =====

  /**
   * Streams loaded transactions in batches
   * Complexity: O(n) where n = number of transactions, but memory efficient
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
    const transactions: Array<{ txid: string; transaction: MempoolTransaction }> = [];
    let batchIndex = 0;
    let processedCount = 0;
    const totalLoaded = this.getTransactionCount();

    for (const [txid, tx] of this.cachedTransactions) {
      if (tx !== null) {
        transactions.push({ txid, transaction: tx });
        processedCount++;

        if (transactions.length >= batchSize) {
          const hasMore = processedCount < totalLoaded;

          yield {
            batch: [...transactions],
            batchIndex,
            hasMore,
          };

          transactions.length = 0; // Clear array
          batchIndex++;

          // Yield control to event loop
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }

    // Yield remaining transactions
    if (transactions.length > 0) {
      yield {
        batch: [...transactions],
        batchIndex,
        hasMore: false,
      };
    }
  }

  /**
   * Streams all cached transactions (including nulls) in batches
   * Complexity: O(n) where n = number of tracked transactions, but memory efficient
   */
  public async *streamCachedTransactions(batchSize: number = 100): AsyncGenerator<
    {
      batch: Array<{ txid: string; transaction: MempoolTransaction | null }>;
      batchIndex: number;
      hasMore: boolean;
    },
    void,
    unknown
  > {
    const transactions: Array<{ txid: string; transaction: MempoolTransaction | null }> = [];
    let batchIndex = 0;
    let processedCount = 0;
    const total = this.cachedTransactions.size;

    for (const [txid, tx] of this.cachedTransactions) {
      transactions.push({ txid, transaction: tx });
      processedCount++;

      if (transactions.length >= batchSize) {
        const hasMore = processedCount < total;

        yield {
          batch: [...transactions],
          batchIndex,
          hasMore,
        };

        transactions.length = 0;
        batchIndex++;

        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (transactions.length > 0) {
      yield {
        batch: [...transactions],
        batchIndex,
        hasMore: false,
      };
    }
  }

  /**
   * Streams transaction IDs in batches
   * Complexity: O(n) where n = number of tracked transactions, but memory efficient
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
    const txids: string[] = [];
    let batchIndex = 0;
    let processedCount = 0;
    const total = this.cachedTransactions.size;

    for (const txid of this.cachedTransactions.keys()) {
      txids.push(txid);
      processedCount++;

      if (txids.length >= batchSize) {
        const hasMore = processedCount < total;

        yield {
          batch: [...txids],
          batchIndex,
          hasMore,
        };

        txids.length = 0;
        batchIndex++;

        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (txids.length > 0) {
      yield {
        batch: [...txids],
        batchIndex,
        hasMore: false,
      };
    }
  }

  /**
   * Streams loaded txids info in batches
   * Complexity: O(n) where n = number of attempted loads, but memory efficient
   */
  public async *streamLoadedTxidsInfo(batchSize: number = 1000): AsyncGenerator<
    {
      batch: Array<{ txid: string; loadInfo: { timestamp: number; feeRate: number } }>;
      batchIndex: number;
      hasMore: boolean;
    },
    void,
    unknown
  > {
    const txidsInfo: Array<{ txid: string; loadInfo: { timestamp: number; feeRate: number } }> = [];
    let batchIndex = 0;
    let processedCount = 0;
    const total = this.loadedTxids.size;

    for (const [txid, loadInfo] of this.loadedTxids) {
      txidsInfo.push({ txid, loadInfo });
      processedCount++;

      if (txidsInfo.length >= batchSize) {
        const hasMore = processedCount < total;

        yield {
          batch: [...txidsInfo],
          batchIndex,
          hasMore,
        };

        txidsInfo.length = 0;
        batchIndex++;

        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (txidsInfo.length > 0) {
      yield {
        batch: [...txidsInfo],
        batchIndex,
        hasMore: false,
      };
    }
  }

  // ===== PUBLIC METHODS =====

  /**
   * Initialize mempool - always gets fresh txids list from node
   * RPC calls: 1 getRawMempool(false)
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
    // Always get fresh txids list from node - 1 RPC call
    const allTxidsFromNode: string[] = await service.getRawMempool(false);

    await this.apply(
      new BitcoinMempoolInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: currentNetworkHeight,
        allTxidsFromNode,
        isSynchronized: false,
      })
    );
  }

  /**
   * Process mempool sync - loads transactions in batches with dynamic batch size adjustment
   * RPC calls: 0-1 getRawMempool(true) OR multiple getMempoolEntries() calls
   * Max event data: ~(batch transactions * 1KB) = dynamically adjusted based on performance
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
    // If no more processing needed, exit early
    if (!hasMoreToProcess) {
      return;
    }

    const syncStartTime = Date.now();

    // Dynamic batch size adjustment based on previous sync performance
    this.adjustBatchSize();

    // Determine which txids need to be loaded
    const txidsToLoad = Array.from(this.cachedTransactions.keys()).filter((txid) => {
      const tx = this.cachedTransactions.get(txid);
      if (tx !== null) return false; // already loaded

      // Check if we already loaded this txid before
      const loadedInfo = this.loadedTxids.get(txid);
      if (loadedInfo) {
        // If we loaded it before and fee rate was below threshold, don't load again
        if (loadedInfo.feeRate < this.minFeeRate) {
          return false;
        }
        // If minFeeRate changed and now this txid might be acceptable, load it
        return loadedInfo.feeRate >= this.minFeeRate;
      }

      return true; // need to load if not in loadedTxids
    });

    let moreToProcess = false;

    if (txidsToLoad.length === 0) {
      // All txids are already loaded - check if we should trigger synchronized event
      if (!this.isSynchronized) {
        const totalTxids = this.cachedTransactions.size;
        const loadedCount = this.getTransactionCount();
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
        }
      }

      // IMPORTANT: we do not doing return here,
      // we only specify when mempool was synchronized first time
    }

    // Determine loading strategy
    const shouldUseFullSync = txidsToLoad.length < this.fullSyncThreshold;

    let loadedTransactions: Array<{ txid: string; transaction: MempoolTransaction }> = [];

    if (shouldUseFullSync) {
      // Use getRawMempool(true) for small sets - 1 RPC call
      const result = await this.loadTransactionsFullSync(txidsToLoad, service);
      loadedTransactions = result.loaded;
    } else {
      // Use batched loading with dynamic batch size
      const txidsToProcess = txidsToLoad.slice(0, this.currentBatchSize);
      moreToProcess = txidsToLoad.length > this.currentBatchSize;

      const result = await this.loadTransactionsBatched(txidsToProcess, service, this.currentBatchSize);
      loadedTransactions = result.loaded;
    }

    // Record sync duration for next adjustment
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
   * Process blocks batch - handles both new blocks
   * Gets fresh txids from mempool after blocks are processed
   * RPC calls: 1 getRawMempool(false)
   * Also cleans up loadedTxids from transactions that were confirmed in blocks
   */
  public async processBlocksBatch({
    requestId,
    blocks,
    service,
  }: {
    requestId: string;
    blocks: Array<{ height: number; hash: string }>;
    service: BlockchainProviderService;
  }) {
    // Get fresh txids from node after blocks processing - 1 RPC call
    const allTxidsFromNode: string[] = await service.getRawMempool(false);

    // Use latest block height from the batch
    const latestBlockHeight = blocks.length > 0 ? blocks[blocks.length - 1]!.height : this.lastBlockHeight;

    // Use same event as init since logic is identical - refresh mempool state
    await this.apply(
      new BitcoinMempoolInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: latestBlockHeight,
        allTxidsFromNode,
        isSynchronized: false,
      })
    );
  }

  /**
   * Process reorganisation - just reload all transactions hashes from mempool
   * Gets fresh txids from mempool
   * RPC calls: 1 getRawMempool(false)
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
    // Get fresh txids from node after reorganisation - 1 RPC call
    const allTxidsFromNode: string[] = await service.getRawMempool(false);

    // Use first block height from the batch (reorg goes back to earliest affected height)
    const reorgBlockHeight = blocks.length > 0 ? blocks[0]!.height : this.lastBlockHeight;

    // Use same event as init since logic is identical - refresh mempool state
    await this.apply(
      new BitcoinMempoolInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: reorgBlockHeight,
        allTxidsFromNode,
        isSynchronized: false,
      })
    );
  }

  public async clearMempool({ requestId }: { requestId: string }) {
    await this.apply(
      new BitcoinMempoolClearedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: -1,
      })
    );
  }

  // ===== PRIVATE HELPERS =====

  /**
   * Dynamically adjusts batch size based on previous sync timing
   * Algorithm:
   * - If timingRatio > 1.2 (current took 20%+ longer), increase batch size by 25%
   * - If timingRatio < 0.8 (current took 20%+ less time), decrease batch size by 25%, but not below 10
   * - If timing is similar (0.8-1.2 range), leave batch size unchanged
   */
  private adjustBatchSize(): void {
    if (this.previousSyncDuration > 0 && this.lastSyncDuration > 0) {
      const timingRatio = this.lastSyncDuration / this.previousSyncDuration;

      if (timingRatio > 1.2) {
        // Current sync took significantly longer - increase batch size for better throughput
        this.currentBatchSize = Math.round(this.currentBatchSize * 1.25);
      } else if (timingRatio < 0.8) {
        // Current sync was significantly faster - can reduce batch size to avoid overwhelming
        this.currentBatchSize = Math.max(10, Math.round(this.currentBatchSize * 0.75));
      }
      // If timing is similar (0.8-1.2), keep current batch size
    }
  }

  private addTransactionToFeeRateIndex(txid: string, transaction: MempoolTransaction) {
    const feeRate = transaction.vsize > 0 ? transaction.fees.base / transaction.vsize : 0;
    const roundedFeeRate = Math.floor(feeRate * 10) / 10; // Round to 0.1 precision

    if (!this.feeRateIndex.has(roundedFeeRate)) {
      this.feeRateIndex.set(roundedFeeRate, new Set());
    }
    this.feeRateIndex.get(roundedFeeRate)!.add(txid);
  }

  private removeTransactionFromFeeRateIndex(txid: string, transaction?: MempoolTransaction) {
    if (!transaction) {
      transaction = this.cachedTransactions.get(txid) as MempoolTransaction;
    }

    if (transaction) {
      const feeRate = transaction.vsize > 0 ? transaction.fees.base / transaction.vsize : 0;
      const roundedFeeRate = Math.floor(feeRate * 10) / 10;
      const feeRateSet = this.feeRateIndex.get(roundedFeeRate);
      if (feeRateSet) {
        feeRateSet.delete(txid);
        if (feeRateSet.size === 0) {
          this.feeRateIndex.delete(roundedFeeRate);
        }
      }
    }
  }

  private cleanupOldLoadedTxids(): void {
    const now = Date.now();
    const expiredTxids: string[] = [];

    for (const [txid, loadInfo] of this.loadedTxids) {
      if (now - loadInfo.timestamp > this.loadedTxidsMaxAge) {
        expiredTxids.push(txid);
      }
    }

    expiredTxids.forEach((txid) => this.loadedTxids.delete(txid));
  }

  /**
   * Load transactions using getRawMempool(true) - 1 RPC call
   */
  private async loadTransactionsFullSync(
    txids: string[],
    service: BlockchainProviderService
  ): Promise<{ loaded: Array<{ txid: string; transaction: MempoolTransaction }> }> {
    const loaded: Array<{ txid: string; transaction: MempoolTransaction }> = [];
    const txidsSet = new Set(txids);

    try {
      const fullMempool = await service.getRawMempool(true);

      for (const [txid, txData] of Object.entries(fullMempool)) {
        if (txidsSet.has(txid)) {
          loaded.push({ txid, transaction: txData as MempoolTransaction });
        }
      }
    } catch (error) {
      // If full sync fails, we'll retry with batched approach next time
    }

    return { loaded };
  }

  /**
   * Load transactions using getMempoolEntries with batching n RPC calls
   */
  private async loadTransactionsBatched(
    txids: string[],
    service: BlockchainProviderService,
    batchSize: number
  ): Promise<{ loaded: Array<{ txid: string; transaction: MempoolTransaction }> }> {
    const loaded: Array<{ txid: string; transaction: MempoolTransaction }> = [];

    for (let i = 0; i < txids.length; i += batchSize) {
      const batch = txids.slice(i, i + batchSize);

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

  // ===== EVENT HANDLERS (IDEMPOTENT) =====

  private onBitcoinMempoolInitializedEvent({ payload }: BitcoinMempoolInitializedEvent) {
    const { allTxidsFromNode } = payload;

    // Always reset synchronization status
    this.isSynchronized = false;

    // Cleanup old loaded txids
    this.cleanupOldLoadedTxids();

    // Build new state based on fresh txids from node
    const nodeSet = new Set(allTxidsFromNode);
    const newCachedTransactions = new Map<string, MempoolTransaction | null>();

    // Keep existing loaded transactions that are still in mempool
    for (const [txid, transaction] of this.cachedTransactions) {
      if (nodeSet.has(txid)) {
        newCachedTransactions.set(txid, transaction);
      } else {
        // Remove from fee rate index if it was loaded
        if (transaction !== null) {
          this.removeTransactionFromFeeRateIndex(txid, transaction);
        }
        // Remove from loadedTxids since it's no longer in mempool (confirmed in block or expired)
        this.loadedTxids.delete(txid);
      }
    }

    // Add new txids as placeholders (null)
    for (const txid of allTxidsFromNode) {
      if (!newCachedTransactions.has(txid)) {
        newCachedTransactions.set(txid, null);
      }
    }

    this.cachedTransactions = newCachedTransactions;
  }

  private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
    const { loadedTransactions } = payload;

    // Add only successfully loaded transactions to cache
    loadedTransactions.forEach(({ txid, transaction }) => {
      const feeRate = transaction.vsize > 0 ? transaction.fees.base / transaction.vsize : 0;

      // Always remember that we loaded this txid
      this.loadedTxids.set(txid, { timestamp: Date.now(), feeRate });

      // Only store if meets minimum fee rate
      if (feeRate >= this.minFeeRate) {
        this.cachedTransactions.set(txid, transaction);
        this.addTransactionToFeeRateIndex(txid, transaction);
      } else {
        // Set to null if fee too low (but keep placeholder)
        this.cachedTransactions.set(txid, null);
      }
    });

    // Failed txids remain as null in cachedTransactions and will be retried next time
  }

  private onBitcoinMempoolSynchronizedEvent({ payload }: BitcoinMempoolSynchronizedEvent) {
    const { isSynchronized } = payload;
    this.isSynchronized = isSynchronized;
  }

  private onBitcoinMempoolClearedEvent({ payload }: BitcoinMempoolClearedEvent) {
    // Clear all collections
    this.cachedTransactions.clear();
    this.feeRateIndex.clear();
    this.loadedTxids.clear();

    // Reset state variables
    this.isSynchronized = false;
    this.currentBatchSize = 150; // reset to initial value
    this.previousSyncDuration = 0;
    this.lastSyncDuration = 0;
  }
}
