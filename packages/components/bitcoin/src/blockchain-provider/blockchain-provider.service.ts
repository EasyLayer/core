import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import type { NetworkConfig, UniversalBlock, UniversalBlockStats, UniversalTransaction } from './node-providers';
import { BitcoinNormalizer } from './normalizer';
import { Block, Transaction, BlockStats, MempoolTransaction, MempoolInfo } from './components';

/**
 * A Subscription is a Promise that resolves once unsubscribed, and also provides
 * an `unsubscribe()` method to cancel the underlying subscription.
 */
export type Subscription = Promise<void> & { unsubscribe: () => void };

@Injectable()
export class BlockchainProviderService {
  private readonly normalizer: BitcoinNormalizer;

  constructor(
    private readonly log: AppLogger,
    private readonly _connectionManager: ConnectionManager,
    private readonly networkConfig: NetworkConfig
  ) {
    this.normalizer = new BitcoinNormalizer(this.networkConfig);
  }

  get connectionManager() {
    return this._connectionManager;
  }

  get config() {
    return this.networkConfig;
  }

  /**
   * Execute provider method with automatic error handling and provider switching
   */
  private async executeProviderMethod<T>(methodName: string, operation: (provider: any) => Promise<T>): Promise<T> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await operation(provider);
    } catch (error) {
      this.log.warn('Bitcoin provider operation failed, attempting recovery', {
        args: { methodName, error: error || 'Unknown error' },
      });

      // Let connection manager handle the failure and provider switching
      try {
        const currentProvider = await this._connectionManager.getActiveProvider();
        const recoveredProvider = await this._connectionManager.handleProviderFailure(
          currentProvider.uniqName,
          error,
          methodName
        );

        // Retry with recovered/switched provider
        return await operation(recoveredProvider);
      } catch (recoveryError) {
        this.log.error('Bitcoin provider recovery failed', {
          args: { methodName, originalError: error, recoveryError },
        });
        throw recoveryError;
      }
    }
  }

  /**
   * Subscribes to new block events via provider (ZMQ for RPC, P2P for P2P)
   * Automatically uses the best available subscription method from active provider
   *
   * @param callback - Function to be invoked whenever a new block is received
   * @returns A Subscription (Promise<void> & { unsubscribe(): void })
   */
  public subscribeToNewBlocks(callback: (block: Block) => void): Subscription {
    let resolveSubscription!: () => void;
    let rejectSubscription!: (error: Error) => void;

    const subscriptionPromise = new Promise<void>((resolve, reject) => {
      resolveSubscription = resolve;
      rejectSubscription = reject;
    }) as Subscription;

    this._connectionManager
      .getActiveProvider()
      .then((provider) => {
        // Check if provider supports block subscriptions
        if (typeof provider.subscribeToNewBlocks !== 'function') {
          rejectSubscription(new Error('Active provider does not support block subscriptions'));
          return;
        }

        try {
          // Subscribe to UniversalBlock and normalize at service level
          const subscription = provider.subscribeToNewBlocks((universalBlock: UniversalBlock) => {
            try {
              // Normalize UniversalBlock to Block at service level
              const normalizedBlock = this.normalizer.normalizeBlock(universalBlock);
              callback(normalizedBlock);
            } catch (error) {
              this.log.warn('Failed to normalize block in subscription', { args: { error } });
            }
          });

          subscriptionPromise.unsubscribe = () => {
            subscription.unsubscribe();
            resolveSubscription();
          };
        } catch (error) {
          rejectSubscription(error as Error);
        }
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

  // ===== BASIC INFO METHODS =====

  /**
   * Gets the current block height
   * Node calls: 1 (getblockcount)
   */
  public async getCurrentBlockHeight(): Promise<number> {
    return this.executeProviderMethod('getCurrentBlockHeight', async (provider) => {
      const height = await provider.getBlockHeight();
      return Number(height);
    });
  }

  /**
   * Gets a block hash by height
   * Node calls: 1 (getblockhash)
   * @returns block hash or null if block doesn't exist
   */
  public async getOneBlockHashByHeight(height: string | number): Promise<string | null> {
    return this.executeProviderMethod('getOneBlockHashByHeight', async (provider) => {
      try {
        const hashes = await provider.getManyBlockHashesByHeights([Number(height)]);
        return hashes[0] || null;
      } catch (error) {
        return null;
      }
    });
  }

  /**
   * Gets multiple block hashes by heights - batch optimized
   * Node calls: 1 (batch getblockhash for all heights)
   */
  public async getManyHashesByHeights(heights: string[] | number[]): Promise<(string | null)[]> {
    return this.executeProviderMethod('getManyHashesByHeights', async (provider) => {
      return await provider.getManyBlockHashesByHeights(heights.map((h) => Number(h)));
    });
  }

  // ===== BLOCK METHODS WITH HEX OPTION =====

  /**
   * Gets a normalized block by height
   * Node calls: 1 (getblockhash + getblock) if useHex=true, 2 (getblockhash + getblock) if useHex=false
   * @param height - block height
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @param verifyMerkle - if true, verifies Merkle root of transactions
   * @returns normalized block or null if block doesn't exist
   */
  public async getOneBlockByHeight(
    height: string | number,
    useHex: boolean = false,
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<Block | null> {
    return this.executeProviderMethod('getOneBlockByHeight', async (provider) => {
      if (useHex) {
        // Get Universal blocks parsed from hex - GUARANTEES HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHeights([Number(height)], verifyMerkle);
        const universalBlock = universalBlocks[0];

        if (!universalBlock) {
          return null;
        }

        return this.normalizer.normalizeBlock(universalBlock);
      } else {
        // Get structured block data - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHeights([Number(height)], verbosity, verifyMerkle);
        const rawBlock = rawBlocks[0];

        if (!rawBlock) {
          return null;
        }

        return this.normalizer.normalizeBlock(rawBlock);
      }
    });
  }

  /**
   * Gets a normalized block by hash
   * Node calls: 1 (getblock) if useHex=true, 2 (getblock + getblock) if useHex=false and height missing
   * @param hash - block hash
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @param verifyMerkle - if true, verifies Merkle root of transactions
   * @returns normalized block or null if block doesn't exist
   */
  public async getOneBlockByHash(
    hash: string,
    useHex: boolean = false,
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<Block | null> {
    return this.executeProviderMethod('getOneBlockByHash', async (provider) => {
      if (useHex) {
        // Get Universal blocks parsed from hex - DOES NOT GUARANTEE HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHashes([hash], verifyMerkle);
        const universalBlock = universalBlocks[0];

        if (!universalBlock) {
          return null;
        }

        // Need to get height separately using public provider method
        const blockInfos = await provider.getManyBlocksByHashes([hash], 1);
        const blockInfo = blockInfos[0];

        if (!blockInfo || blockInfo.height === undefined) {
          return null; // Cannot guarantee height
        }

        // Set height and normalize
        universalBlock.height = blockInfo.height;
        return this.normalizer.normalizeBlock(universalBlock);
      } else {
        // Get structured block data - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHashes([hash], verbosity, verifyMerkle);
        const rawBlock = rawBlocks[0];

        if (!rawBlock) {
          return null;
        }

        return this.normalizer.normalizeBlock(rawBlock);
      }
    });
  }

  /**
   * Gets multiple normalized blocks by heights
   * Node calls: 1 (batch getblockhash + batch getblock) if useHex=true, 1 (batch getblockhash + batch getblock) if useHex=false
   * @param heights - array of block heights
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @param verifyMerkle - if true, verifies Merkle root of transactions
   */
  public async getManyBlocksByHeights(
    heights: string[] | number[],
    useHex: boolean = false,
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<Block[]> {
    return this.executeProviderMethod('getManyBlocksByHeights', async (provider) => {
      if (useHex) {
        // Get Universal blocks parsed from hex - GUARANTEES HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHeights(
          heights.map((item) => Number(item)),
          verifyMerkle
        );

        // Filter out null blocks and normalize
        const validBlocks = universalBlocks.filter((block: any): block is UniversalBlock => block !== null);
        return this.normalizer.normalizeManyBlocks(validBlocks);
      } else {
        // Get structured blocks - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHeights(
          heights.map((item) => Number(item)),
          verbosity,
          verifyMerkle
        );

        // Filter out null blocks and normalize
        const validBlocks = rawBlocks.filter((block: any): block is UniversalBlock => block !== null);
        return this.normalizer.normalizeManyBlocks(validBlocks);
      }
    });
  }

  /**
   * Gets multiple normalized blocks by hashes
   * Node calls: 1 (batch getblock) if useHex=false, 2 (batch getblock + batch getblock) if useHex=true and heights needed
   * @param hashes - array of block hashes
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @param verifyMerkle - if true, verifies Merkle root of transactions
   */
  public async getManyBlocksByHashes(
    hashes: string[],
    useHex: boolean = false,
    verbosity: number = 1,
    verifyMerkle: boolean = false
  ): Promise<Block[]> {
    return this.executeProviderMethod('getManyBlocksByHashes', async (provider) => {
      if (useHex) {
        // Get Universal blocks parsed from hex - DOES NOT GUARANTEE HEIGHT
        const universalBlocks = await provider.getManyBlocksHexByHashes(hashes, verifyMerkle);

        // Get heights for valid blocks using public provider method
        const validHashes = hashes.filter((_, index) => universalBlocks[index] !== null);
        if (validHashes.length === 0) {
          return [];
        }

        // Get height info for valid hashes using structured method
        const heightInfos = await provider.getManyBlocksByHashes(validHashes, 1);

        // Combine blocks with heights, filter out invalid
        const completeBlocks: UniversalBlock[] = [];
        let heightIndex = 0;

        universalBlocks.forEach((block: any, index: any) => {
          if (block !== null) {
            const heightInfo = heightInfos[heightIndex++];
            if (heightInfo && heightInfo.height !== undefined) {
              block.height = heightInfo.height;
              completeBlocks.push(block);
            }
            // If no height info, skip this block
          }
        });

        return this.normalizer.normalizeManyBlocks(completeBlocks);
      } else {
        // Get structured blocks - GUARANTEES HEIGHT
        const rawBlocks = await provider.getManyBlocksByHashes(hashes, verbosity, verifyMerkle);

        // Filter out null blocks and normalize
        const validBlocks = rawBlocks.filter((block: any): block is UniversalBlock => block !== null);
        return this.normalizer.normalizeManyBlocks(validBlocks);
      }
    });
  }

  // ===== BLOCK STATS METHODS =====

  /**
   * Gets block statistics by heights using batch calls
   * Node calls: 2 (batch getblockhash + batch getblockstats, with special genesis handling)
   */
  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<BlockStats[]> {
    return this.executeProviderMethod('getManyBlocksStatsByHeights', async (provider) => {
      // Get raw stats - GUARANTEES HEIGHT
      const rawStats = await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));

      // Filter out null stats and normalize
      const validStats = rawStats.filter((stats: any): stats is UniversalBlockStats => stats !== null);
      return this.normalizer.normalizeManyBlockStats(validStats);
    });
  }

  /**
   * Gets block statistics by hashes using batch calls
   * Node calls: 1 (batch getblockstats for all hashes)
   */
  public async getManyBlocksStatsByHashes(hashes: string[]): Promise<BlockStats[]> {
    return this.executeProviderMethod('getManyBlocksStatsByHashes', async (provider) => {
      // Get raw stats - GUARANTEES HEIGHT (blockstats includes height)
      const rawStats = await provider.getManyBlocksStatsByHashes(hashes);

      // Filter out null stats and normalize
      const validStats = rawStats.filter((stats: any): stats is UniversalBlockStats => stats !== null);
      return this.normalizer.normalizeManyBlockStats(validStats);
    });
  }

  // ===== TRANSACTION METHODS =====

  /**
   * Gets multiple transactions by txids - batch optimized
   * @param txids - array of transaction IDs
   * @param useHex - if true, uses hex parsing for better performance and complete transaction data
   * @param verbosity - verbosity level for object method (ignored if useHex=true)
   * @returns transactions or empty array if none exist
   */
  public async getTransactionsByTxids(
    txids: string[],
    useHex: boolean = false,
    verbosity: number = 1
  ): Promise<Transaction[]> {
    return this.executeProviderMethod('getTransactionsByTxids', async (provider) => {
      if (useHex) {
        // Get Universal transactions parsed from hex
        const universalTxs = await provider.getManyTransactionsHexByTxids(txids);

        // Filter out null transactions and normalize
        const validTxs = universalTxs.filter((tx: any): tx is UniversalTransaction => tx !== null);
        return this.normalizer.normalizeManyTransactions(validTxs);
      } else {
        // Get structured transaction data
        const rawTxs = await provider.getManyTransactionsByTxids(txids, verbosity);

        // Filter out null transactions and normalize
        const validTxs = rawTxs.filter((tx: any): tx is UniversalTransaction => tx !== null);
        return this.normalizer.normalizeManyTransactions(validTxs);
      }
    });
  }

  // ===== NETWORK METHODS =====

  /**
   * Gets blockchain information
   */
  public async getBlockchainInfo(): Promise<any> {
    return this.executeProviderMethod('getBlockchainInfo', async (provider) => {
      return await provider.getBlockchainInfo();
    });
  }

  /**
   * Gets network information
   */
  public async getNetworkInfo(): Promise<any> {
    return this.executeProviderMethod('getNetworkInfo', async (provider) => {
      return await provider.getNetworkInfo();
    });
  }

  public async getMempoolInfo(): Promise<MempoolInfo> {
    return this.executeProviderMethod('getMempoolInfo', async (provider) => {
      return await provider.getMempoolInfo();
    });
  }

  public async getRawMempool(verbose: boolean = false): Promise<any> {
    return this.executeProviderMethod('getRawMempool', async (provider) => {
      return await provider.getRawMempool(verbose);
    });
  }

  public async getMempoolEntries(txids: string[]): Promise<(MempoolTransaction | null)[]> {
    return this.executeProviderMethod('getMempoolEntries', async (provider) => {
      return await provider.getMempoolEntries(txids);
    });
  }

  /**
   * Estimates smart fee
   */
  public async estimateSmartFee(confTarget: number, estimateMode: string = 'CONSERVATIVE'): Promise<any> {
    return this.executeProviderMethod('estimateSmartFee', async (provider) => {
      return await provider.estimateSmartFee(confTarget, estimateMode);
    });
  }

  // ===== NETWORK FEATURE UTILITY METHODS =====

  /**
   * Utility method to check if a feature is supported by the current network
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

  // ===== CONVENIENCE METHODS FOR BETTER API =====

  /**
   * High-performance method: Gets a fully parsed block with all transactions and Merkle verification
   * This is the fastest and most secure way to get complete block with all transactions
   * @returns block or null if doesn't exist
   */
  public async getFullBlockByHeight(height: string | number, verifyMerkle: boolean = false): Promise<Block | null> {
    return this.getOneBlockByHeight(height, true, 1, verifyMerkle); // Force hex parsing with optional Merkle verification
  }

  /**
   * High-performance method: Gets a fully parsed block with all transactions and Merkle verification
   * @returns block or null if doesn't exist
   */
  public async getFullBlockByHash(hash: string, verifyMerkle: boolean = false): Promise<Block | null> {
    return this.getOneBlockByHash(hash, true, 1, verifyMerkle); // Force hex parsing with optional Merkle verification
  }

  /**
   * High-performance method: Gets multiple fully parsed blocks with all transactions and Merkle verification
   * This is the most efficient and secure way to get multiple complete blocks
   */
  public async getFullBlocksByHeights(heights: string[] | number[], verifyMerkle: boolean = false): Promise<Block[]> {
    return this.getManyBlocksByHeights(heights, true, 1, verifyMerkle); // Force hex parsing with optional Merkle verification
  }

  /**
   * High-performance method: Gets multiple fully parsed blocks with all transactions and Merkle verification
   */
  public async getFullBlocksByHashes(hashes: string[], verifyMerkle: boolean = false): Promise<Block[]> {
    return this.getManyBlocksByHashes(hashes, true, 1, verifyMerkle); // Force hex parsing with optional Merkle verification
  }

  /**
   * Lightweight method: Gets basic block info without transactions
   * @returns block or null if doesn't exist
   */
  public async getBasicBlockByHeight(height: string | number): Promise<Block | null> {
    return this.getOneBlockByHeight(height, false, 1); // Force object parsing with verbosity 1
  }

  /**
   * Lightweight method: Gets basic block info without transactions
   * @returns block or null if doesn't exist
   */
  public async getBasicBlockByHash(hash: string): Promise<Block | null> {
    return this.getOneBlockByHash(hash, false, 1); // Force object parsing with verbosity 1
  }

  /**
   * Lightweight method: Gets multiple basic blocks without transactions
   */
  public async getBasicBlocksByHeights(heights: string[] | number[]): Promise<Block[]> {
    return this.getManyBlocksByHeights(heights, false, 1); // Force object parsing with verbosity 1
  }

  /**
   * Lightweight method: Gets multiple basic blocks without transactions
   */
  public async getBasicBlocksByHashes(hashes: string[]): Promise<Block[]> {
    return this.getManyBlocksByHashes(hashes, false, 1); // Force object parsing with verbosity 1
  }
}
