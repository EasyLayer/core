import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, MempoolTransaction, Transaction, LightBlock } from '../../blockchain-provider';
import {
  BitcoinMempoolInitializedEvent,
  BitcoinMempoolSyncProcessedEvent,
  BitcoinMempoolClearedEvent,
  BitcoinMempoolSynchronizedEvent,
  BitcoinMempoolBlockBatchProcessedEvent,
} from '../events';
import { MempoolNotLoadedError, MempoolSizeMismatchError } from './errors';

/**
 * Optimized Bitcoin Mempool Aggregate with multi-provider aggregation strategy
 *
 * Memory Strategy:
 * - Hash-based Map storage using 32-bit hashes instead of 64-byte txid strings
 * - Saves ~60 bytes per transaction (64 string -> 4 number) = ~2MB for 34k transactions
 * - Store full Transaction objects (~4-6KB each) only for transactions meeting fee criteria
 * - Store MempoolTransaction metadata (~200-500 bytes each) for all transactions via getRawMempool(true)
 * - Provider mapping using indices instead of names (saves ~80% memory for many providers)
 *
 * Multi-Provider Strategy:
 * - Use getRawMempool(false) to get all unique txids from ALL providers simultaneously
 * - Use getRawMempool(true) to get metadata from all providers in one batch call (~10-25MB for 50k txids)
 * - Track which provider each transaction came from for targeted full data fetching
 * - Use getMempoolTransactionsByTxids() to get complete transaction data efficiently
 * - Deduplicate transactions across providers (load each txid only once)
 *
 * Core Storage Maps:
 * - txidHashToTxid: Reverse mapping from 32-bit hash to original txid string (API compatibility)
 * - transactionMetadata: MempoolTransaction objects for all txids (metadata from getRawMempool(true))
 * - fullTransactions: Complete Transaction objects only for txids meeting fee criteria
 * - loadedTxids: Tracking which txids were processed (prevents reloading)
 * - providerMapping: Which providers have each txid (for targeted queries)
 *
 * Memory Usage Estimation for 50k transactions:
 * - Transaction objects: ~200-250MB (4-5KB each for transactions meeting fee criteria)
 * - Metadata entries: ~10-25MB (200-500 bytes each for all transactions)
 * - Hash mappings: ~2.4MB (48 bytes per txid: hash + reverse mapping)
 * - Provider mappings: ~3.8MB (optimized with indices)
 * - Tracking structures: ~1.5MB (fee indexes, loaded tracking)
 * Total: ~218-283MB for 50k transactions (vs ~325MB raw data = 67-87% efficiency)
 */
export class Mempool extends AggregateRoot {
  private minFeeRate: number;
  private syncThresholdPercent: number = 0.9;
  private currentBatchSize: number = 200; // Optimized for getMempoolTransactionsByTxids batch size

  // State tracking
  private isSynchronized: boolean = false;

  // Core storage with 32-bit hash optimization
  // Memory: 4 bytes per key + object size
  private txidHashToTxid: Map<number, string> = new Map(); // Reverse mapping: hash -> original txid (for API compatibility)
  private transactionMetadata: Map<number, MempoolTransaction> = new Map(); // Mempool metadata for all txids (from getRawMempool(true))
  private fullTransactions: Map<number, Transaction> = new Map(); // Full transaction data for high-fee txids only
  private loadedTxids: Map<number, { timestamp: number; feeRate: number; providerIndex: number }> = new Map(); // Tracking processed txids

  // Provider tracking with memory optimization
  // Memory: ~8 bytes per txid for provider mapping
  private providerMapping: Map<number, Set<number>> = new Map(); // txidHash -> Set<providerIndex>
  private providerNames: string[] = []; // Provider names from service (loaded once)

  // Fee rate indexing for efficient operations
  // Memory: ~200KB for fee rate grouping
  private feeRateIndex: Map<number, Set<number>> = new Map();
  private feeRatePrecision: number = 10; // Round to 0.1 sat/vB

  constructor({
    aggregateId,
    blockHeight,
    minFeeRate = 1,
    feeRatePrecision = 10,
    options,
  }: {
    aggregateId: string;
    blockHeight: number;
    minFeeRate?: number;
    feeRatePrecision?: number;
    options?: {
      snapshotsEnabled?: boolean;
      allowPruning?: boolean;
      snapshotInterval?: number;
    };
  }) {
    super(aggregateId, blockHeight, options);

    this.minFeeRate = minFeeRate;
    this.feeRatePrecision = feeRatePrecision;
  }

  // ========== PRIVATE UTILITY METHODS ==========

  /**
   * Hash txid string to 32-bit integer for memory efficiency
   * Memory savings: 64 bytes -> 4 bytes = 60 bytes per txid
   * Time complexity: O(n) where n = txid length (64 chars)
   */
  private hashTxid(txid: string): number {
    let hash = 0;
    for (let i = 0; i < txid.length; i++) {
      hash = ((hash << 5) - hash + txid.charCodeAt(i)) & 0xffffffff;
    }
    return hash >>> 0;
  }

  /**
   * Calculate fee rate from MempoolTransaction metadata
   * Time complexity: O(1)
   */
  private calculateMempoolFeeRate(metadata: MempoolTransaction): number {
    return metadata.vsize > 0 ? metadata.fee / metadata.vsize : 0;
  }

  /**
   * Calculate fee rate from full Transaction object
   * Time complexity: O(1)
   */
  private calculateTransactionFeeRate(transaction: Transaction): number {
    if (transaction.fee !== undefined && transaction.vsize > 0) {
      return transaction.fee / transaction.vsize;
    }
    return 0;
  }

  /**
   * Round fee rate for indexing efficiency
   * Reduces unique fee rate buckets for better grouping
   */
  private roundFeeRate(feeRate: number): number {
    return Math.floor(feeRate * this.feeRatePrecision) / this.feeRatePrecision;
  }

  /**
   * Add transaction to fee rate index
   * Time complexity: O(1)
   */
  private addToFeeRateIndex(feeRate: number, txidHash: number): void {
    const roundedFeeRate = this.roundFeeRate(feeRate);
    if (!this.feeRateIndex.has(roundedFeeRate)) {
      this.feeRateIndex.set(roundedFeeRate, new Set());
    }
    this.feeRateIndex.get(roundedFeeRate)!.add(txidHash);
  }

  /**
   * Remove transaction from fee rate index
   * Time complexity: O(1)
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
   * Add provider mapping for transaction
   * Time complexity: O(1)
   */
  private addProviderMapping(txidHash: number, providerIndex: number): void {
    if (!this.providerMapping.has(txidHash)) {
      this.providerMapping.set(txidHash, new Set<number>());
    }
    this.providerMapping.get(txidHash)!.add(providerIndex);
  }

  /**
   * Get or create provider index for provider name
   * Memory optimization: use indices instead of storing provider names multiple times
   */
  private getProviderIndex(providerName: string): number {
    const existingIndex = this.providerNames.indexOf(providerName);
    if (existingIndex !== -1) {
      return existingIndex;
    }

    // Add new provider
    this.providerNames.push(providerName);
    return this.providerNames.length - 1;
  }

  /**
   * Check if transaction was already loaded
   * Time complexity: O(1)
   */
  private isTransactionAlreadyLoaded(txidHash: number): boolean {
    return this.loadedTxids.has(txidHash);
  }

  /**
   * Remove transaction completely from all storage
   * Time complexity: O(1)
   */
  private removeTransactionCompletely(txidHash: number): void {
    // Remove from fee rate index first if metadata exists
    const metadata = this.transactionMetadata.get(txidHash);
    if (metadata) {
      const feeRate = this.calculateMempoolFeeRate(metadata);
      this.removeFromFeeRateIndex(feeRate, txidHash);
    }

    // Remove from all maps
    this.transactionMetadata.delete(txidHash);
    this.fullTransactions.delete(txidHash);
    this.loadedTxids.delete(txidHash);
    this.txidHashToTxid.delete(txidHash);
    this.providerMapping.delete(txidHash);
  }

  /**
   * Get original txid from hash
   * Time complexity: O(1)
   */
  private getOriginalTxid(txidHash: number): string | undefined {
    return this.txidHashToTxid.get(txidHash);
  }

  /**
   * Get provider name from index
   * Time complexity: O(1)
   */
  private getProviderName(providerIndex: number): string | undefined {
    return this.providerNames[providerIndex];
  }

  /**
   * Filter transactions by already loaded status
   * Returns txids that need full transaction loading
   * Note: metadata is already filtered by fee rate in init(), so no need to check fee rate again
   */
  private filterTransactionsForLoading(): string[] {
    const txidsToLoad: string[] = [];

    for (const [txidHash, metadata] of this.transactionMetadata) {
      // Skip if already loaded
      if (this.isTransactionAlreadyLoaded(txidHash)) continue;

      // Metadata is already filtered by minFeeRate in init(), so all transactions here meet criteria
      const originalTxid = this.getOriginalTxid(txidHash);
      if (originalTxid) {
        txidsToLoad.push(originalTxid);
      }
    }

    return txidsToLoad;
  }

  // ========== PUBLIC COMMAND METHODS ==========

  /**
   * Initialize mempool by aggregating data from ALL providers
   * Strategy: Get all unique txids + metadata via getRawMempool calls, filter by fee rate
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
    // Reset provider names for fresh start
    this.providerNames = [];

    // Get raw mempool txids and metadata from ALL providers in parallel
    // Node calls: 2 per provider in parallel (getRawMempool false + true)
    const [allRawMempoolsTxids, allRawMempoolsMetadata] = await Promise.all([
      service.getRawMempoolFromAll(false), // txids only
      service.getRawMempoolFromAll(true), // full metadata (~10-25MB for 50k txids)
    ]);

    if (allRawMempoolsTxids.length === 0) {
      throw new MempoolNotLoadedError();
    }

    // Aggregate all unique txids and metadata from successful providers
    const aggregatedTxids = new Set<string>();
    const aggregatedMetadata = new Map<string, MempoolTransaction>();
    const providerTxidMapping = new Map<string, number[]>();

    for (let i = 0; i < allRawMempoolsTxids.length; i++) {
      const rawMempoolTxids = allRawMempoolsTxids[i];
      const rawMempoolMetadata = allRawMempoolsMetadata[i];

      if (!Array.isArray(rawMempoolTxids)) continue;

      const providerName = `provider_${i}`;
      const providerIndex = this.getProviderIndex(providerName);

      // Process txids
      for (const txid of rawMempoolTxids) {
        aggregatedTxids.add(txid);

        if (!providerTxidMapping.has(txid)) {
          providerTxidMapping.set(txid, []);
        }
        providerTxidMapping.get(txid)!.push(providerIndex);
      }

      // Process metadata if available
      if (rawMempoolMetadata && typeof rawMempoolMetadata === 'object') {
        for (const [txid, metadata] of Object.entries(rawMempoolMetadata)) {
          if (metadata && typeof metadata === 'object') {
            aggregatedMetadata.set(txid, metadata as MempoolTransaction);
          }
        }
      }
    }

    const allTxidsFromNode = Array.from(aggregatedTxids);

    if (allTxidsFromNode.length === 0) {
      throw new MempoolSizeMismatchError();
    }

    // Filter metadata by fee rate criteria - only include txids that meet minimum fee rate
    const filteredMetadata = new Map<string, MempoolTransaction>();
    for (const [txid, metadata] of aggregatedMetadata) {
      const feeRate = this.calculateMempoolFeeRate(metadata);
      if (feeRate >= this.minFeeRate) {
        filteredMetadata.set(txid, metadata);
      }
    }

    // Event payload size estimation:
    // - allTxidsFromNode: ~50k txids × 64 bytes = ~3.2MB
    // - filteredMetadata: ~10k entries × 350 bytes = ~3.5MB (filtered by fee rate)
    // - providerTxidMapping: ~50k entries × 12 bytes = ~600KB
    // Total event size: ~7.3MB for 50k total transactions (10k high-fee)
    await this.apply(
      new BitcoinMempoolInitializedEvent(
        {
          aggregateId: this.aggregateId,
          requestId,
          blockHeight: currentNetworkHeight,
        },
        {
          allTxidsFromNode,
          isSynchronized: false,
          providerTxidMapping: Object.fromEntries(providerTxidMapping),
          aggregatedMetadata: Object.fromEntries(filteredMetadata), // Only high-fee metadata
        }
      )
    );
  }

  /**
   * Process mempool sync by loading full transaction data for high-fee transactions
   * Strategy: Filter already loaded and load full data via getMempoolTransactionsByTxids
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
    if (!hasMoreToProcess) {
      return;
    }

    // Check synchronization threshold based on metadata loading progress
    if (!this.isSynchronized) {
      const totalMetadataExpected = this.transactionMetadata.size;
      const loadedCount = this.loadedTxids.size;
      const loadedPercent = totalMetadataExpected > 0 ? loadedCount / totalMetadataExpected : 0;

      if (loadedPercent >= this.syncThresholdPercent) {
        await this.apply(
          new BitcoinMempoolSynchronizedEvent(
            {
              aggregateId: this.aggregateId,
              requestId,
              blockHeight: this.lastBlockHeight,
            },
            {
              isSynchronized: true,
            }
          )
        );
        return;
      }
    }

    // Find txids that need full transaction loading
    const txidsToLoad = this.filterTransactionsForLoading();

    if (txidsToLoad.length === 0) {
      return;
    }

    // Process in batches
    const batchToProcess = txidsToLoad.slice(0, this.currentBatchSize);
    const hasMore = txidsToLoad.length > this.currentBatchSize;

    // Load full transaction data for selected txids
    // Node calls: 1 per provider (batch getMempoolTransactionsByTxids)
    // Transaction objects: ~4-6KB each × batch size = ~800KB-1.2MB per batch
    const fullTransactionsData = await service.getMempoolTransactionsByTxids(batchToProcess, true, 1);

    // Combine for event
    const loadedTransactions: Array<{
      txid: string;
      transaction: Transaction;
      providerIndex: number;
    }> = [];

    for (let i = 0; i < batchToProcess.length; i++) {
      const txid = batchToProcess[i];
      const fullTransaction = fullTransactionsData[i];

      if (txid && fullTransaction) {
        const txidHash = this.hashTxid(txid);
        const providerIndices = this.providerMapping.get(txidHash);
        const providerIndex = providerIndices ? Array.from(providerIndices)[0] ?? 0 : 0;

        loadedTransactions.push({
          txid,
          transaction: fullTransaction,
          providerIndex,
        });
      }
    }

    // Event payload size estimation:
    // - loadedTransactions: ~200 txids × (64 bytes txid + 5KB transaction) = ~1MB per batch
    // - hasMoreToProcess: 1 byte
    // Total event size: ~1MB per sync batch
    await this.apply(
      new BitcoinMempoolSyncProcessedEvent(
        {
          aggregateId: this.aggregateId,
          requestId,
          blockHeight: this.lastBlockHeight,
        },
        {
          loadedTransactions,
          hasMoreToProcess: hasMore,
        }
      )
    );
  }

  /**
   * Process new blocks and remove confirmed transactions from mempool
   * Strategy: Extract confirmed txids from blocks and remove them from storage
   */
  public async processBlocksBatch({ requestId, blocks }: { requestId: string; blocks: LightBlock[] }) {
    // Extract all transaction IDs from blocks
    const confirmedTxids = new Set<string>();

    for (const block of blocks) {
      if (block.tx && Array.isArray(block.tx)) {
        for (const txid of block.tx) {
          if (typeof txid === 'string') {
            confirmedTxids.add(txid);
          }
        }
      }
    }

    if (confirmedTxids.size === 0) {
      return;
    }

    // Find which of our stored transactions were confirmed
    const txidsToRemove: string[] = [];
    for (const txid of confirmedTxids) {
      const txidHash = this.hashTxid(txid);
      if (this.txidHashToTxid.has(txidHash)) {
        txidsToRemove.push(txid);
      }
    }

    if (txidsToRemove.length === 0) {
      return;
    }

    const latestBlockHeight =
      blocks.length > 0 ? blocks[blocks.length - 1]?.height || this.lastBlockHeight : this.lastBlockHeight;

    // Event payload size estimation:
    // - txidsToRemove: ~1000 txids × 64 bytes = ~64KB per block batch
    // Total event size: ~64KB per block batch
    await this.apply(
      new BitcoinMempoolBlockBatchProcessedEvent(
        {
          aggregateId: this.aggregateId,
          requestId,
          blockHeight: latestBlockHeight,
        },
        {
          txidsToRemove,
        }
      )
    );
  }

  /**
   * Process blockchain reorganization - refresh mempool state completely
   * Strategy: Similar to init() - get fresh mempool data and rebuild state
   */
  public async processReorganisation({
    requestId,
    blocks,
    service,
  }: {
    requestId: string;
    blocks: Array<{ height: number; hash: string; tx?: string[] }>;
    service: BlockchainProviderService;
  }) {
    // Get fresh mempool data after reorganization
    const [allRawMempoolsTxids, allRawMempoolsMetadata] = await Promise.all([
      service.getRawMempoolFromAll(false),
      service.getRawMempoolFromAll(true),
    ]);

    if (allRawMempoolsTxids.length === 0) {
      throw new MempoolSizeMismatchError();
    }

    // Aggregate fresh txids and metadata
    const aggregatedTxids = new Set<string>();
    const aggregatedMetadata = new Map<string, MempoolTransaction>();
    const providerTxidMapping = new Map<string, number[]>();

    for (let i = 0; i < allRawMempoolsTxids.length; i++) {
      const rawMempoolTxids = allRawMempoolsTxids[i];
      const rawMempoolMetadata = allRawMempoolsMetadata[i];

      if (!Array.isArray(rawMempoolTxids)) continue;

      const providerName = `provider_${i}`;
      const providerIndex = this.getProviderIndex(providerName);

      for (const txid of rawMempoolTxids) {
        aggregatedTxids.add(txid);

        if (!providerTxidMapping.has(txid)) {
          providerTxidMapping.set(txid, []);
        }
        providerTxidMapping.get(txid)!.push(providerIndex);
      }

      // Process metadata if available
      if (rawMempoolMetadata && typeof rawMempoolMetadata === 'object') {
        for (const [txid, metadata] of Object.entries(rawMempoolMetadata)) {
          if (metadata && typeof metadata === 'object') {
            aggregatedMetadata.set(txid, metadata as MempoolTransaction);
          }
        }
      }
    }

    const allTxidsFromNode = Array.from(aggregatedTxids);
    const reorgBlockHeight = blocks.length > 0 ? blocks[0]?.height || this.lastBlockHeight : this.lastBlockHeight;

    // Filter metadata by fee rate criteria
    const filteredMetadata = new Map<string, MempoolTransaction>();
    for (const [txid, metadata] of aggregatedMetadata) {
      const feeRate = this.calculateMempoolFeeRate(metadata);
      if (feeRate >= this.minFeeRate) {
        filteredMetadata.set(txid, metadata);
      }
    }

    // Event payload size estimation: same as init (~7.3MB for 50k total/10k high-fee transactions)
    await this.apply(
      new BitcoinMempoolInitializedEvent(
        {
          aggregateId: this.aggregateId,
          requestId,
          blockHeight: reorgBlockHeight,
        },
        {
          allTxidsFromNode,
          isSynchronized: false,
          providerTxidMapping: Object.fromEntries(providerTxidMapping),
          aggregatedMetadata: Object.fromEntries(filteredMetadata),
        }
      )
    );
  }

  /**
   * Clear mempool completely
   */
  public async clearMempool({ requestId }: { requestId: string }) {
    // Event payload size estimation: ~1KB (minimal data)
    await this.apply(
      new BitcoinMempoolClearedEvent(
        {
          aggregateId: this.aggregateId,
          requestId,
          blockHeight: -1,
        },
        {}
      )
    );
  }

  // ========== EVENT HANDLERS (IDEMPOTENT) ==========

  private onBitcoinMempoolInitializedEvent({ payload }: BitcoinMempoolInitializedEvent) {
    const { allTxidsFromNode, isSynchronized, providerTxidMapping, aggregatedMetadata } = payload;

    // Reset synchronization if explicitly set to false
    if (isSynchronized === false) {
      this.isSynchronized = false;
    }

    // Build new state from event data
    const newTxidHashToTxid = new Map<number, string>();
    const newTransactionMetadata = new Map<number, MempoolTransaction>();
    const newProviderMapping = new Map<number, Set<number>>();

    // Process all txids from event
    for (const txid of allTxidsFromNode) {
      const txidHash = this.hashTxid(txid);
      newTxidHashToTxid.set(txidHash, txid);
    }

    // Process metadata if available in event
    if (aggregatedMetadata) {
      for (const [txid, metadata] of Object.entries(aggregatedMetadata)) {
        if (metadata && typeof metadata === 'object') {
          const txidHash = this.hashTxid(txid);
          newTransactionMetadata.set(txidHash, metadata as MempoolTransaction);
        }
      }
    }

    // Build provider mapping
    if (providerTxidMapping) {
      for (const [txid, providerIndices] of Object.entries(providerTxidMapping)) {
        if (Array.isArray(providerIndices)) {
          const txidHash = this.hashTxid(txid);
          newProviderMapping.set(txidHash, new Set(providerIndices));
        }
      }
    }

    // Remove transactions no longer in mempool (idempotent cleanup)
    const currentTxidHashes = new Set(this.txidHashToTxid.keys());
    const newTxidHashes = new Set(newTxidHashToTxid.keys());

    for (const txidHash of currentTxidHashes) {
      if (!newTxidHashes.has(txidHash)) {
        this.removeTransactionCompletely(txidHash);
      }
    }

    // Update core state with new data
    this.txidHashToTxid = newTxidHashToTxid;
    this.transactionMetadata = newTransactionMetadata;
    this.providerMapping = newProviderMapping;
  }

  private onBitcoinMempoolSyncProcessedEvent({ payload }: BitcoinMempoolSyncProcessedEvent) {
    const { loadedTransactions } = payload;

    for (const { txid, transaction, providerIndex } of loadedTransactions) {
      const txidHash = this.hashTxid(txid);

      // Calculate fee rate from transaction
      const feeRate = this.calculateTransactionFeeRate(transaction);

      // Track as loaded (idempotent)
      this.loadedTxids.set(txidHash, {
        timestamp: Date.now(),
        feeRate,
        providerIndex: providerIndex ?? 0,
      });

      // Store full transaction data if meets fee criteria (idempotent)
      if (feeRate >= this.minFeeRate) {
        this.fullTransactions.set(txidHash, transaction);
        this.addToFeeRateIndex(feeRate, txidHash);
      }

      // Update provider mapping (idempotent)
      if (providerIndex !== undefined) {
        this.addProviderMapping(txidHash, providerIndex);
      }

      // Ensure reverse mapping exists (idempotent)
      this.txidHashToTxid.set(txidHash, txid);
    }
  }

  private onBitcoinMempoolSynchronizedEvent({ payload }: BitcoinMempoolSynchronizedEvent) {
    const { isSynchronized } = payload;
    this.isSynchronized = isSynchronized;
  }

  private onBitcoinMempoolBlockBatchProcessedEvent({ payload }: BitcoinMempoolBlockBatchProcessedEvent) {
    const { txidsToRemove } = payload;

    if (txidsToRemove && Array.isArray(txidsToRemove)) {
      // Remove specific transactions
      for (const txid of txidsToRemove) {
        const txidHash = this.hashTxid(txid);
        this.removeTransactionCompletely(txidHash);
      }
    } else {
      // Clear all storage (idempotent) - when txidsToRemove is not provided
      this.txidHashToTxid.clear();
      this.transactionMetadata.clear();
      this.fullTransactions.clear();
      this.loadedTxids.clear();
      this.providerMapping.clear();
      this.feeRateIndex.clear();
      this.providerNames = [];

      // Reset state (idempotent)
      this.isSynchronized = false;
      this.currentBatchSize = 200;
    }
  }

  private onBitcoinMempoolClearedEvent({ payload }: BitcoinMempoolClearedEvent) {
    // Clear all storage Maps (idempotent)
    this.txidHashToTxid.clear();
    this.transactionMetadata.clear();
    this.fullTransactions.clear();
    this.loadedTxids.clear();
    this.providerMapping.clear();
    this.feeRateIndex.clear();

    // Reset provider names array
    this.providerNames = [];

    // Reset all state variables to initial values
    this.isSynchronized = false;
    this.currentBatchSize = 200;
  }

  // ========== SNAPSHOTS ==========

  // protected toJsonPayload(): any {
  //   return {
  //     minFeeRate: this.minFeeRate,
  //     syncThresholdPercent: this.syncThresholdPercent,
  //     currentBatchSize: this.currentBatchSize,
  //     isSynchronized: this.isSynchronized,
  //     feeRatePrecision: this.feeRatePrecision,
  //     // Convert Maps to arrays for JSON serialization
  //     txidHashToTxid: Array.from(this.txidHashToTxid.entries()),
  //     transactionMetadata: Array.from(this.transactionMetadata.entries()),
  //     fullTransactions: Array.from(this.fullTransactions.entries()),
  //     loadedTxids: Array.from(this.loadedTxids.entries()),
  //     providerMapping: Array.from(this.providerMapping.entries()).map(([key, value]) => [key, Array.from(value)]),
  //     providerNames: this.providerNames,
  //   };
  // }

  // protected fromSnapshot(state: any): void {
  //   // Safety check for state
  //   if (!state || typeof state !== 'object') {
  //     return;
  //   }

  //   // Restore primitive values with safe defaults
  //   this.minFeeRate = typeof state.minFeeRate === 'number' ? state.minFeeRate : 1;
  //   this.syncThresholdPercent = typeof state.syncThresholdPercent === 'number' ? state.syncThresholdPercent : 0.9;
  //   this.currentBatchSize = typeof state.currentBatchSize === 'number' ? state.currentBatchSize : 200;
  //   this.isSynchronized = Boolean(state.isSynchronized);
  //   this.feeRatePrecision = typeof state.feeRatePrecision === 'number' ? state.feeRatePrecision : 10;

  //   // Restore Maps from arrays with safety checks
  //   this.txidHashToTxid = new Map(Array.isArray(state.txidHashToTxid) ? state.txidHashToTxid : []);
  //   this.transactionMetadata = new Map(Array.isArray(state.transactionMetadata) ? state.transactionMetadata : []);
  //   this.fullTransactions = new Map(Array.isArray(state.fullTransactions) ? state.fullTransactions : []);
  //   this.loadedTxids = new Map(Array.isArray(state.loadedTxids) ? state.loadedTxids : []);
  //   this.providerNames = Array.isArray(state.providerNames) ? state.providerNames : [];

  //   // Restore provider mapping with Set conversion and safety checks
  //   this.providerMapping = new Map();
  //   if (Array.isArray(state.providerMapping)) {
  //     for (const [key, value] of state.providerMapping) {
  //       if (typeof key === 'number' && Array.isArray(value)) {
  //         this.providerMapping.set(key, new Set(value));
  //       }
  //     }
  //   }

  //   // Rebuild fee rate index from current full transactions
  //   this.feeRateIndex.clear();
  //   for (const [txidHash, transaction] of this.fullTransactions) {
  //     const feeRate = this.calculateTransactionFeeRate(transaction);
  //     this.addToFeeRateIndex(feeRate, txidHash);
  //   }

  //   Object.setPrototypeOf(this, Mempool.prototype);
  // }

  // ========== PUBLIC READ-ONLY API METHODS ==========

  /**
   * Get all current transaction IDs
   * Time complexity: O(n) where n = number of transactions
   * Memory: Creates new array with original txid strings
   */
  public getCurrentTxids(): string[] {
    return Array.from(this.txidHashToTxid.values());
  }

  /**
   * Get transaction metadata by txid
   * Time complexity: O(1)
   * Returns MempoolTransaction with fee, size, dependencies info (~200-500 bytes)
   */
  public getTransactionMetadata(txid: string): MempoolTransaction | undefined {
    const txidHash = this.hashTxid(txid);
    return this.transactionMetadata.get(txidHash);
  }

  /**
   * Get full transaction data by txid
   * Time complexity: O(1)
   * Returns complete Transaction with vin/vout data (~4-6KB)
   */
  public getFullTransaction(txid: string): Transaction | undefined {
    const txidHash = this.hashTxid(txid);
    return this.fullTransactions.get(txidHash);
  }

  /**
   * Check if transaction exists in mempool
   * Time complexity: O(1)
   */
  public hasTransaction(txid: string): boolean {
    const txidHash = this.hashTxid(txid);
    return this.txidHashToTxid.has(txidHash);
  }

  /**
   * Check if transaction was loaded (has metadata or full data)
   * Time complexity: O(1)
   */
  public isTransactionLoaded(txid: string): boolean {
    const txidHash = this.hashTxid(txid);
    return this.loadedTxids.has(txidHash);
  }

  /**
   * Get providers that have specific transaction
   * Time complexity: O(1)
   */
  public getProvidersForTransaction(txid: string): string[] {
    const txidHash = this.hashTxid(txid);
    const providerIndices = this.providerMapping.get(txidHash);

    if (!providerIndices) return [];

    const providerNames: string[] = [];
    for (const index of providerIndices) {
      const providerName = this.getProviderName(index);
      if (providerName) {
        providerNames.push(providerName);
      }
    }

    return providerNames;
  }

  /**
   * Get all transactions with fee rate above threshold
   * Time complexity: O(n) where n = number of metadata entries
   * Memory: Creates new array of txids
   */
  public getTransactionsAboveFeeRate(minFeeRate: number): string[] {
    const result: string[] = [];

    for (const [txidHash, metadata] of this.transactionMetadata) {
      const feeRate = this.calculateMempoolFeeRate(metadata);
      if (feeRate >= minFeeRate) {
        const txid = this.getOriginalTxid(txidHash);
        if (txid) {
          result.push(txid);
        }
      }
    }

    return result;
  }

  /**
   * Get transactions by fee rate range
   * Time complexity: O(n) where n = number of metadata entries
   * Memory: Creates new array of transaction data
   */
  public getTransactionsByFeeRateRange(
    minFeeRate: number,
    maxFeeRate: number
  ): Array<{
    txid: string;
    feeRate: number;
    metadata: MempoolTransaction;
    fullTransaction?: Transaction;
  }> {
    const result: Array<{
      txid: string;
      feeRate: number;
      metadata: MempoolTransaction;
      fullTransaction?: Transaction;
    }> = [];

    for (const [txidHash, metadata] of this.transactionMetadata) {
      const feeRate = this.calculateMempoolFeeRate(metadata);
      if (feeRate >= minFeeRate && feeRate <= maxFeeRate) {
        const txid = this.getOriginalTxid(txidHash);
        if (txid) {
          const fullTransaction = this.fullTransactions.get(txidHash);
          result.push({
            txid,
            feeRate,
            metadata,
            fullTransaction,
          });
        }
      }
    }

    return result.sort((a, b) => b.feeRate - a.feeRate); // Sort by fee rate descending
  }

  /**
   * Get top N transactions by fee rate
   * Time complexity: O(n log n) where n = number of metadata entries
   * Memory: Creates sorted array of top transactions
   */
  public getTopTransactionsByFeeRate(limit: number = 100): Array<{
    txid: string;
    feeRate: number;
    metadata: MempoolTransaction;
    fullTransaction?: Transaction;
  }> {
    const allTransactions = this.getTransactionsByFeeRateRange(0, Infinity);
    return allTransactions.slice(0, limit);
  }

  /**
   * Get mempool size by transaction count and memory usage
   * Time complexity: O(1)
   * Memory: Creates small statistics object
   */
  public getMempoolSize(): {
    txidCount: number;
    metadataCount: number;
    fullTransactionCount: number;
    estimatedMemoryUsage: {
      txidMappings: number; // bytes
      metadata: number; // bytes
      fullTransactions: number; // bytes
      providerMappings: number; // bytes
      total: number; // bytes
    };
  } {
    const txidCount = this.txidHashToTxid.size;
    const metadataCount = this.transactionMetadata.size;
    const fullTransactionCount = this.fullTransactions.size;

    // Estimate memory usage
    const txidMappingsMemory = txidCount * 72; // 4 bytes hash + 64 bytes txid + overhead
    const metadataMemory = metadataCount * 350; // ~350 bytes per MempoolTransaction
    const fullTransactionsMemory = fullTransactionCount * 5000; // ~5KB per Transaction
    const providerMappingsMemory = txidCount * 20; // ~20 bytes per txid for provider mapping

    const totalMemory = txidMappingsMemory + metadataMemory + fullTransactionsMemory + providerMappingsMemory;

    return {
      txidCount,
      metadataCount,
      fullTransactionCount,
      estimatedMemoryUsage: {
        txidMappings: txidMappingsMemory,
        metadata: metadataMemory,
        fullTransactions: fullTransactionsMemory,
        providerMappings: providerMappingsMemory,
        total: totalMemory,
      },
    };
  }

  /**
   * Get mempool statistics
   * Time complexity: O(n) for fee rate calculations
   * Memory: Creates small statistics object
   */
  public getMempoolStats(): {
    totalTxids: number;
    loadedMetadata: number;
    loadedFullTransactions: number;
    syncProgress: number;
    isSynchronized: boolean;
    averageFeeRate: number;
    medianFeeRate: number;
    totalProviders: number;
    feeRateDistribution: { [feeRate: number]: number }; // fee rate bucket -> count
  } {
    const totalTxids = this.txidHashToTxid.size;
    const loadedMetadata = this.transactionMetadata.size;
    const loadedFullTransactions = this.fullTransactions.size;
    const syncProgress = totalTxids > 0 ? this.loadedTxids.size / totalTxids : 0;

    // Calculate fee rate statistics
    const feeRates: number[] = [];
    const feeRateDistribution: { [feeRate: number]: number } = {};

    for (const metadata of this.transactionMetadata.values()) {
      const feeRate = this.calculateMempoolFeeRate(metadata);
      feeRates.push(feeRate);

      // Create distribution buckets (rounded to feeRatePrecision)
      const roundedFeeRate = this.roundFeeRate(feeRate);
      feeRateDistribution[roundedFeeRate] = (feeRateDistribution[roundedFeeRate] || 0) + 1;
    }

    const averageFeeRate = feeRates.length > 0 ? feeRates.reduce((sum, rate) => sum + rate, 0) / feeRates.length : 0;

    let medianFeeRate = 0;
    if (feeRates.length > 0) {
      feeRates.sort((a, b) => a - b);
      const mid = Math.floor(feeRates.length / 2);
      medianFeeRate = feeRates.length % 2 === 0 ? (feeRates[mid - 1]! + feeRates[mid]!) / 2 : feeRates[mid]!;
    }

    return {
      totalTxids,
      loadedMetadata,
      loadedFullTransactions,
      syncProgress,
      isSynchronized: this.isSynchronized,
      averageFeeRate,
      medianFeeRate,
      totalProviders: this.providerNames.length,
      feeRateDistribution,
    };
  }

  /**
   * Get transactions that are ready for processing (loaded and meet criteria)
   * Time complexity: O(n) where n = number of loaded transactions
   * Memory: Creates new array of transaction references
   */
  public getReadyTransactions(): Array<{
    txid: string;
    transaction: Transaction;
    metadata: MempoolTransaction;
    feeRate: number;
    loadedAt: number;
    providerIndex: number;
  }> {
    const result: Array<{
      txid: string;
      transaction: Transaction;
      metadata: MempoolTransaction;
      feeRate: number;
      loadedAt: number;
      providerIndex: number;
    }> = [];

    for (const [txidHash, loadedInfo] of this.loadedTxids) {
      const txid = this.getOriginalTxid(txidHash);
      const transaction = this.fullTransactions.get(txidHash);
      const metadata = this.transactionMetadata.get(txidHash);

      if (txid && transaction && metadata) {
        result.push({
          txid,
          transaction,
          metadata,
          feeRate: loadedInfo.feeRate,
          loadedAt: loadedInfo.timestamp,
          providerIndex: loadedInfo.providerIndex,
        });
      }
    }

    return result.sort((a, b) => b.feeRate - a.feeRate); // Sort by fee rate descending
  }

  /**
   * Check if mempool is ready for business operations
   * Time complexity: O(1)
   */
  public isReady(): boolean {
    return this.isSynchronized && this.transactionMetadata.size > 0;
  }

  /**
   * Get synchronization progress details
   * Time complexity: O(1)
   */
  public getSyncProgress(): {
    isSynchronized: boolean;
    progress: number; // 0-1
    totalExpected: number;
    loaded: number;
    remaining: number;
  } {
    const totalExpected = this.transactionMetadata.size;
    const loaded = this.loadedTxids.size;
    const remaining = Math.max(0, totalExpected - loaded);
    const progress = totalExpected > 0 ? loaded / totalExpected : 0;

    return {
      isSynchronized: this.isSynchronized,
      progress,
      totalExpected,
      loaded,
      remaining,
    };
  }

  /**
   * Get all provider names currently registered
   * Time complexity: O(1)
   */
  public getProviderNames(): string[] {
    return [...this.providerNames]; // Return copy to prevent external modification
  }
}
