import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import type { NetworkConnectionManager, MempoolConnectionManager, MempoolRequestOptions } from './managers';
import type { NetworkProvider, MempoolProvider } from './providers';
import type { NetworkConfig, UniversalBlock, UniversalBlockStats, UniversalTransaction } from './transports';
import { BitcoinNormalizer } from './normalizer';
import { BitcoinMerkleVerifier } from './merkle-verifier';
import { Block, Transaction, BlockStats, MempoolTransaction, MempoolInfo } from './components';

/**
 * A Subscription is a Promise that resolves once unsubscribed, and also provides
 * an `unsubscribe()` method to cancel the underlying subscription.
 */
export type Subscription = Promise<void> & { unsubscribe: () => void };

/**
 * Blockchain Provider Service - Main service interface for Bitcoin-compatible blockchain operations
 *
 * Architecture:
 * - NetworkConnectionManager: Single active provider with automatic failover
 * - MempoolConnectionManager: Multiple providers with configurable strategies
 * - Unified interface for both RPC and P2P transports
 * - Supports Bitcoin-compatible chains (BTC, BCH, DOGE, LTC) via network config
 * - Automatic error handling and provider switching
 * - Built-in normalization and validation
 *
 * Performance characteristics:
 * - Block operations: Optimized batch calls where possible
 * - Mempool operations: Configurable strategies (parallel, round-robin, fastest)
 * - Memory usage: No caching - immediate processing and forwarding
 * - Error recovery: Automatic provider switching with exponential backoff
 */
@Injectable()
export class BlockchainProviderService {
  private readonly normalizer: BitcoinNormalizer;

  constructor(
    private readonly log: AppLogger,
    private readonly networkConnectionManager: NetworkConnectionManager,
    private readonly mempoolConnectionManager: MempoolConnectionManager,
    private readonly networkConfig: NetworkConfig
  ) {
    this.normalizer = new BitcoinNormalizer(this.networkConfig);
  }

  get networkManager() {
    return this.networkConnectionManager;
  }

  get mempoolManager() {
    return this.mempoolConnectionManager;
  }

  get config() {
    return this.networkConfig;
  }

  // ===== PRIVATE HELPER METHODS =====

  /**
   * Check if network providers are available
   */
  private hasNetworkProviders(): boolean {
    return this.networkConnectionManager.allProviders.length > 0;
  }

  /**
   * Check if mempool providers are available
   */
  private hasMempoolProviders(): boolean {
    return this.mempoolConnectionManager.allProviders.length > 0;
  }

  /**
   * Throw error if no network providers are available
   */
  private ensureNetworkProviders(): void {
    if (!this.hasNetworkProviders()) {
      throw new Error('No network providers configured. Please configure at least one network provider.');
    }
  }

  /**
   * Throw error if no mempool providers are available
   */
  private ensureMempoolProviders(): void {
    if (!this.hasMempoolProviders()) {
      throw new Error('No mempool providers configured. Please configure at least one mempool provider.');
    }
  }

  /**
   * Verify merkle root for blocks with special genesis handling
   * Uses BitcoinMerkleVerifier to perform cryptographic verification
   */
  private verifyBlockMerkleRoot(block: UniversalBlock): boolean {
    if (block.height === 0) {
      // Genesis block verification
      return BitcoinMerkleVerifier.verifyGenesisMerkleRoot(block);
    } else {
      // Regular block verification
      return BitcoinMerkleVerifier.verifyBlockMerkleRoot(block, this.networkConfig.hasSegWit);
    }
  }

  /**
   * Filter out null values and verify merkle roots for blocks
   * Performs Merkle tree verification with special genesis block handling
   */
  private processAndValidateBlocks(blocks: (UniversalBlock | null)[], verifyMerkle: boolean = false): Block[] {
    const validBlocks: UniversalBlock[] = [];

    for (const block of blocks) {
      if (block === null) continue;

      if (verifyMerkle) {
        const isValid = this.verifyBlockMerkleRoot(block);
        if (!isValid) {
          throw new Error(`Merkle root verification failed for block ${block.hash} at height ${block.height}`);
        }
      }

      validBlocks.push(block);
    }

    return this.normalizer.normalizeManyBlocks(validBlocks);
  }

  // ===== SUBSCRIPTION METHODS =====

  /**
   * Subscribe to new block events with automatic normalization
   * Node calls: 0 (real-time messages from transport)
   * Memory usage: No block storage - immediate callback execution
   *
   * Automatically uses the best available subscription method from active provider:
   * - RPC transport: ZMQ rawblock messages
   * - P2P transport: Direct P2P block messages
   *
   * @param callback Function to call when new block arrives
   * @returns Subscription promise with unsubscribe method
   */
  // BlockchainProviderService — optional error handler
  public subscribeToNewBlocks(callback: (block: Block) => void, onError?: (err: Error) => void): Subscription {
    this.ensureNetworkProviders();
    let resolveSubscription!: () => void;
    let rejectSubscription!: (error: Error) => void;

    const subscriptionPromise = new Promise<void>((resolve, reject) => {
      resolveSubscription = resolve;
      rejectSubscription = reject;
    }) as Subscription;

    this.networkConnectionManager
      .getActiveProvider()
      .then((provider) => {
        const networkProvider = provider as NetworkProvider;
        if (typeof networkProvider.subscribeToNewBlocks !== 'function') {
          rejectSubscription(new Error('Active provider does not support block subscriptions'));
          return;
        }

        const sub = networkProvider.subscribeToNewBlocks(
          (uBlock) => {
            try {
              // Merkle verify as before
              const isValid =
                uBlock.height === 0
                  ? BitcoinMerkleVerifier.verifyGenesisMerkleRoot(uBlock)
                  : BitcoinMerkleVerifier.verifyBlockMerkleRoot(uBlock, this.networkConfig.hasSegWit);
              if (!isValid) {
                this.log.warn('Merkle root verification failed for subscribed block', {
                  args: { blockHash: uBlock.hash, height: uBlock.height },
                });
                return;
              }
              const normalized = this.normalizer.normalizeBlock(uBlock);
              callback(normalized);
            } catch (err) {
              this.log.warn('Failed to process block in subscription', { args: { error: err } });
              onError?.(err as Error);
            }
          },
          (err) => {
            // bubble transport errors
            this.log.warn('Subscription transport error', { args: { error: err } });
            onError?.(err);
          }
        );

        subscriptionPromise.unsubscribe = () => {
          sub.unsubscribe();
          resolveSubscription();
        };
      })
      .catch((error) => {
        this.log.error('Failed to get provider for subscription', {
          args: { error },
          methodName: 'subscribeToNewBlocks()',
        });
        rejectSubscription(error as Error);
      });

    return subscriptionPromise;
  }

  // ===== NETWORK OPERATIONS (using networkConnectionManager) =====

  /**
   * Execute network provider method with automatic error handling and provider switching
   * Implements automatic failover with exponential backoff
   *
   * @param methodName Name of the method being executed (for logging)
   * @param operation Function to execute on the network provider
   * @returns Result of the operation
   */
  private async executeNetworkProviderMethod<T>(
    methodName: string,
    operation: (provider: NetworkProvider) => Promise<T>
  ): Promise<T> {
    this.ensureNetworkProviders();

    try {
      const provider = (await this.networkConnectionManager.getActiveProvider()) as NetworkProvider;
      return await operation(provider);
    } catch (error) {
      this.log.warn('Network provider operation failed, attempting recovery', {
        args: { methodName, error: error || 'Unknown error' },
      });

      try {
        const currentProvider = await this.networkConnectionManager.getActiveProvider();
        const recoveredProvider = (await this.networkConnectionManager.handleProviderFailure(
          currentProvider.uniqName,
          error,
          methodName
        )) as NetworkProvider;

        return await operation(recoveredProvider);
      } catch (recoveryError) {
        this.log.error('Network provider recovery failed', {
          args: { methodName, originalError: error, recoveryError },
        });
        throw recoveryError;
      }
    }
  }

  /**
   * Get current blockchain height
   * Node calls: 1 (getblockcount for RPC, cached for P2P)
   * Time complexity: O(1)
   *
   * @returns Current blockchain height
   */
  public async getCurrentBlockHeightFromNetwork(): Promise<number> {
    return this.executeNetworkProviderMethod('getCurrentBlockHeight', async (provider) => {
      const height = await provider.getBlockHeight();
      return Number(height);
    });
  }

  /**
   * Get a single block hash by height
   * Node calls: 1 (getblockhash for RPC, cached lookup for P2P)
   * Time complexity: O(1)
   *
   * @param height Block height to get hash for
   * @returns Block hash or null if block doesn't exist
   */
  public async getOneBlockHashByHeight(height: string | number): Promise<string | null> {
    return this.executeNetworkProviderMethod('getOneBlockHashByHeight', async (provider) => {
      try {
        const hashes = await provider.getManyBlockHashesByHeights([Number(height)]);
        return hashes[0] || null;
      } catch (error) {
        return null;
      }
    });
  }

  /**
   * Get multiple block hashes by heights - batch optimized
   * Node calls: 1 (batch getblockhash for all heights)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @returns Array of hashes in same order as input heights, null for missing blocks
   */
  public async getManyHashesByHeights(heights: string[] | number[]): Promise<(string | null)[]> {
    return this.executeNetworkProviderMethod('getManyHashesByHeights', async (provider) => {
      return await provider.getManyBlockHashesByHeights(heights.map((h) => Number(h)));
    });
  }

  /**
   * Get a basic block by height (with transaction hashes only, not full transactions)
   * Node calls: 2 (getblockhash + getblock) for RPC, cached lookup + GetData for P2P
   * Time complexity: O(1) with guaranteed height information
   *
   * Recommended method for reorg detection as it provides minimal data but guarantees height accuracy
   *
   * @param height Block height
   * @returns Normalized block with transaction hashes only, or null if block doesn't exist
   */
  public async getBasicBlockByHeight(height: string | number): Promise<Block | null> {
    return this.executeNetworkProviderMethod('getBasicBlockByHeight', async (provider) => {
      const rawBlocks = await provider.getManyBlocksByHeights([Number(height)], 1);
      const rawBlock = rawBlocks[0];

      if (!rawBlock) return null;
      return this.normalizer.normalizeBlock(rawBlock);
    });
  }

  /**
   * Get multiple blocks by heights with configurable options
   * Node calls: 1-2 depending on method (batch operations)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @param useHex If true, uses hex parsing via requestHexBlocks for better performance
   * @param verbosity Verbosity level for object method (ignored if useHex=true)
   * @param verifyMerkle If true, verifies Merkle root of transactions
   * @returns Array of blocks in same order as input heights, with guaranteed height information
   */
  public async getManyBlocksByHeights(
    heights: string[] | number[],
    useHex: boolean = false,
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<Block[]> {
    return this.executeNetworkProviderMethod('getManyBlocksByHeights', async (provider) => {
      let universalBlocks: (UniversalBlock | null)[];

      if (useHex) {
        universalBlocks = await provider.getManyBlocksHexByHeights(heights.map((item) => Number(item)));
      } else {
        universalBlocks = await provider.getManyBlocksByHeights(
          heights.map((item) => Number(item)),
          verbosity
        );
      }

      return this.processAndValidateBlocks(universalBlocks, verifyMerkle);
    });
  }

  /**
   * Get multiple blocks by hashes with configurable options
   * Node calls: 1-2 depending on method and whether heights are needed
   * Time complexity: O(k) where k = number of hashes
   *
   * @param hashes Array of block hashes
   * @param useHex If true, uses hex parsing via requestHexBlocks for better performance
   * @param verbosity Verbosity level for object method (ignored if useHex=true)
   * @param verifyMerkle If true, verifies Merkle root of transactions
   * @returns Array of blocks in same order as input hashes, with height information
   */
  public async getManyBlocksByHashes(
    hashes: string[],
    useHex: boolean = false,
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<Block[]> {
    return this.executeNetworkProviderMethod('getManyBlocksByHashes', async (provider) => {
      let universalBlocks: (UniversalBlock | null)[];

      if (useHex) {
        universalBlocks = await provider.getManyBlocksHexByHashes(hashes);

        const validHashes = hashes.filter((_, index) => universalBlocks[index] !== null);
        if (validHashes.length === 0) return [];

        const heights = await provider.getHeightsByHashes(validHashes);

        const completeBlocks: UniversalBlock[] = [];
        let heightIndex = 0;

        universalBlocks.forEach((block: any) => {
          if (block !== null) {
            const h = heights[heightIndex++];
            if (typeof h === 'number') {
              block.height = h;
            }
            // TODO: think about thi case when block without height
            completeBlocks.push(block);
          }
        });

        return this.processAndValidateBlocks(completeBlocks, verifyMerkle);
      } else {
        universalBlocks = await provider.getManyBlocksByHashes(hashes, verbosity);
        return this.processAndValidateBlocks(universalBlocks, verifyMerkle);
      }
    });
  }

  /**
   * Get block statistics by heights using batch calls
   * Node calls: 2 (batch getblockhash + batch getblockstats, with special genesis handling)
   * Time complexity: O(k) where k = number of heights
   *
   * @param heights Array of block heights
   * @returns Array of stats in same order as input heights
   */
  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<BlockStats[]> {
    return this.executeNetworkProviderMethod('getManyBlocksStatsByHeights', async (provider) => {
      const rawStats = await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));

      const validStats = rawStats.filter((stats: any): stats is UniversalBlockStats => stats !== null);
      return this.normalizer.normalizeManyBlockStats(validStats);
    });
  }

  /**
   * Get block statistics by hashes using batch calls
   * Node calls: 1 (batch getblockstats for all hashes)
   * Time complexity: O(k) where k = number of hashes
   *
   * @param hashes Array of block hashes
   * @returns Array of stats in same order as input hashes
   */
  public async getManyBlocksStatsByHashes(hashes: string[]): Promise<BlockStats[]> {
    return this.executeNetworkProviderMethod('getManyBlocksStatsByHashes', async (provider) => {
      const rawStats = await provider.getManyBlocksStatsByHashes(hashes);

      const validStats = rawStats.filter((stats: any): stats is UniversalBlockStats => stats !== null);
      return this.normalizer.normalizeManyBlockStats(validStats);
    });
  }

  /**
   * Get multiple transactions by txids - batch optimized (Network Provider)
   * Node calls: 1 (batch getrawtransaction for all txids)
   * Time complexity: O(k) where k = number of txids
   *
   * @param txids Array of transaction IDs
   * @param useHex If true, uses hex parsing for better performance and complete transaction data
   * @param verbosity Verbosity level for object method (ignored if useHex=true)
   * @returns Array of transactions in same order as input txids
   */
  public async getTransactionsByTxids(
    txids: string[],
    useHex: boolean = false,
    verbosity: number = 1
  ): Promise<Transaction[]> {
    return this.executeNetworkProviderMethod('getTransactionsByTxids', async (provider) => {
      let universalTxs: (UniversalTransaction | null)[];

      if (useHex) {
        universalTxs = await provider.getManyTransactionsHexByTxids(txids);
      } else {
        universalTxs = await provider.getManyTransactionsByTxids(txids, verbosity);
      }

      const validTxs = universalTxs.filter((tx: any): tx is UniversalTransaction => tx !== null);
      return this.normalizer.normalizeManyTransactions(validTxs);
    });
  }

  /**
   * Get blockchain information
   * Node calls: 1 (getblockchaininfo)
   */
  public async getBlockchainInfo(): Promise<any> {
    return this.executeNetworkProviderMethod('getBlockchainInfo', async (provider) => {
      return await provider.getBlockchainInfo();
    });
  }

  /**
   * Get network information
   * Node calls: 1 (getnetworkinfo)
   */
  public async getNetworkInfo(): Promise<any> {
    return this.executeNetworkProviderMethod('getNetworkInfo', async (provider) => {
      return await provider.getNetworkInfo();
    });
  }

  /**
   * Estimate smart fee via network provider
   * Node calls: 1 (estimatesmartfee)
   */
  public async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    return this.executeNetworkProviderMethod('estimateSmartFee', async (provider) => {
      return await provider.estimateSmartFee(confTarget, estimateMode);
    });
  }

  // ===== MEMPOOL OPERATIONS (using mempoolConnectionManager) =====

  /**
   * Get multiple transactions by txids from mempool providers with strategy
   * Node calls: 1 per provider (batch getrawtransaction for all txids)
   * Time complexity: O(k) where k = number of txids
   *
   * @param txids Array of transaction IDs
   * @param useHex If true, uses hex parsing for better performance
   * @param verbosity Verbosity level for object method (ignored if useHex=true)
   * @param options Mempool request options (strategy, timeout, etc.)
   * @returns Array of transactions in same order as input txids
   */
  public async getMempoolTransactionsByTxids(
    txids: string[],
    useHex: boolean = false,
    verbosity: number = 1,
    options: MempoolRequestOptions = {}
  ): Promise<Transaction[]> {
    this.ensureMempoolProviders();

    let universalTxs: (UniversalTransaction | null)[];

    if (useHex) {
      universalTxs = await this.mempoolConnectionManager.executeWithStrategy(
        async (provider: MempoolProvider) => await provider.getManyTransactionsHexByTxids(txids),
        options
      );
    } else {
      universalTxs = await this.mempoolConnectionManager.executeWithStrategy(
        async (provider: MempoolProvider) => await provider.getManyTransactionsByTxids(txids, verbosity),
        options
      );
    }

    const validTxs = universalTxs.filter((tx: any): tx is UniversalTransaction => tx !== null);
    return this.normalizer.normalizeManyTransactions(validTxs);
  }

  /**
   * Get current blockchain height from mempool providers with strategy
   * Node calls: 1 per provider (getblockcount)
   * Time complexity: O(1)
   *
   * @param options Mempool request options (strategy, timeout, etc.)
   * @returns Current blockchain height
   */
  public async getCurrentBlockHeightFromMempool(options: MempoolRequestOptions = {}): Promise<number> {
    this.ensureMempoolProviders();
    const height = await this.mempoolConnectionManager.executeWithStrategy(
      async (provider: MempoolProvider) => await provider.getBlockHeight(),
      options
    );
    return Number(height);
  }

  /**
   * Get mempool information using specified strategy
   * Node calls: 1 per provider (getmempoolinfo)
   * Time complexity: O(1)
   * Memory usage: Minimal - just returns current mempool state
   *
   * @param options Mempool request options (strategy, timeout, etc.)
   * @returns Mempool information
   */
  public async getMempoolInfo(options: MempoolRequestOptions = {}): Promise<MempoolInfo> {
    this.ensureMempoolProviders();
    return this.mempoolConnectionManager.executeWithStrategy(
      async (provider: MempoolProvider) => await provider.getMempoolInfo(),
      options
    );
  }

  /**
   * Get raw mempool using specified strategy
   * Node calls: 1 per provider (getrawmempool)
   * Time complexity: O(n) where n = number of transactions in mempool
   * Memory usage: Depends on mempool size and verbosity
   *
   * @param verbose If true, returns detailed transaction info; if false, returns array of txids
   * @param options Mempool request options (strategy, timeout, etc.)
   * @returns Raw mempool data
   */
  public async getRawMempool(verbose: boolean = false, options: MempoolRequestOptions = {}): Promise<any> {
    this.ensureMempoolProviders();
    return this.mempoolConnectionManager.executeWithStrategy(
      async (provider: MempoolProvider) => await provider.getRawMempool(verbose),
      options
    );
  }

  /**
   * Get mempool entries using specified strategy
   * Node calls: 1 per provider (batch getmempoolentry for all txids)
   * Time complexity: O(k) where k = number of txids
   *
   * @param txids Array of transaction IDs to get mempool entries for
   * @param options Mempool request options (strategy, timeout, etc.)
   * @returns Array of mempool entries in same order as input
   */
  public async getMempoolEntries(
    txids: string[],
    options: MempoolRequestOptions = {}
  ): Promise<(MempoolTransaction | null)[]> {
    this.ensureMempoolProviders();
    return this.mempoolConnectionManager.executeWithStrategy(
      async (provider: MempoolProvider) => await provider.getMempoolEntries(txids),
      options
    );
  }

  /**
   * Get mempool information from all providers (parallel execution)
   * Node calls: 1 per provider in parallel (getmempoolinfo)
   * Time complexity: O(1) with parallel execution
   *
   * @returns Array of mempool info from all providers
   */
  public async getMempoolInfoFromAll(): Promise<MempoolInfo[]> {
    this.ensureMempoolProviders();
    return this.mempoolConnectionManager.executeOnMultiple(
      async (provider: MempoolProvider) => await provider.getMempoolInfo()
    );
  }

  /**
   * Get raw mempool from all providers (parallel execution)
   * Node calls: 1 per provider in parallel (getrawmempool)
   * Time complexity: O(n) where n = number of transactions in mempool
   *
   * @param verbose If true, returns detailed transaction info; if false, returns array of txids
   * @returns Array of raw mempool data from all providers
   */
  public async getRawMempoolFromAll(verbose: boolean = false): Promise<any[]> {
    this.ensureMempoolProviders();
    return this.mempoolConnectionManager.executeOnMultiple(
      async (provider: MempoolProvider) => await provider.getRawMempool(verbose)
    );
  }

  /**
   * Estimate smart fee using mempool provider with specified strategy
   * Node calls: 1 per provider (estimatesmartfee)
   * Time complexity: O(1)
   *
   * @param confTarget Target number of confirmations
   * @param estimateMode Estimation mode ('CONSERVATIVE' or 'ECONOMICAL')
   * @param options Mempool request options (strategy, timeout, etc.)
   * @returns Fee estimation data
   */
  public async estimateSmartFeeFromMempool(
    confTarget: number,
    estimateMode: string = 'CONSERVATIVE',
    options: MempoolRequestOptions = {}
  ): Promise<any> {
    this.ensureMempoolProviders();
    return this.mempoolConnectionManager.executeWithStrategy(
      async (provider: MempoolProvider) => await provider.estimateSmartFee(confTarget, estimateMode),
      options
    );
  }

  // ===== UTILITY METHODS =====

  /**
   * Check if a feature is supported by the current network
   * Time complexity: O(1)
   *
   * @param feature Feature to check support for
   * @returns True if feature is supported
   */
  public isFeatureSupported(feature: 'segwit' | 'taproot' | 'rbf' | 'csv' | 'cltv'): boolean {
    switch (feature) {
      case 'segwit':
        return this.networkConfig.hasSegWit;
      case 'taproot':
        return this.networkConfig.hasTaproot;
      case 'rbf':
        return this.networkConfig.hasRBF;
      case 'csv':
        return this.networkConfig.hasCSV;
      case 'cltv':
        return this.networkConfig.hasCLTV;
      default:
        return false;
    }
  }

  /**
   * Get network provider connection options
   */
  public getNetworkProviderConnectionOptions(): any[] {
    return this.networkConnectionManager.getConnectionOptionsForAllProviders();
  }

  /**
   * Get mempool provider connection options
   */
  public getMempoolProviderConnectionOptions(): any[] {
    return this.mempoolConnectionManager.getConnectionOptionsForAllProviders();
  }

  /**
   * Get active network provider name
   */
  public async getActiveNetworkProviderName(): Promise<string> {
    this.ensureNetworkProviders();
    const provider = await this.networkConnectionManager.getActiveProvider();
    return provider.uniqName;
  }

  /**
   * Manually switch network provider
   */
  public async switchNetworkProvider(providerName: string): Promise<void> {
    this.ensureNetworkProviders();
    await this.networkConnectionManager.switchProvider(providerName);
  }

  /**
   * Get specific network provider
   */
  public async getNetworkProviderByName(name: string) {
    return this.networkConnectionManager.getProviderByName(name);
  }

  /**
   * Get specific mempool provider
   */
  public async getMempoolProviderByName(name: string) {
    return this.mempoolConnectionManager.getProviderByName(name);
  }

  /**
   * Remove network provider
   */
  public async removeNetworkProvider(name: string): Promise<boolean> {
    return this.networkConnectionManager.removeProvider(name);
  }

  /**
   * Remove mempool provider
   */
  public async removeMempoolProvider(name: string): Promise<boolean> {
    return this.mempoolConnectionManager.removeProvider(name);
  }

  /**
   * Check if network providers are available
   */
  public hasNetworkProvidersAvailable(): boolean {
    return this.hasNetworkProviders();
  }

  /**
   * Check if mempool providers are available
   */
  public hasMempoolProvidersAvailable(): boolean {
    return this.hasMempoolProviders();
  }
}
