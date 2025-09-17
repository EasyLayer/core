import { Injectable, Logger } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import type { Hash, NetworkConfig, UniversalBlock, UniversalTransactionReceipt } from './node-providers';
import { BlockchainNormalizer } from './normalizer';
import { Block, Transaction, TransactionReceipt } from './components';
import { BlockSizeCalculator } from './utils';

/**
 * A Subscription is a Promise that resolves once unsubscribed, and also provides
 * an `unsubscribe()` method to cancel the underlying WebSocket listener.
 */
export type Subscription = Promise<void> & { unsubscribe: () => void };

@Injectable()
export class BlockchainProviderService {
  log = new Logger(BlockchainProviderService.name);
  private readonly normalizer: BlockchainNormalizer;

  constructor(
    private readonly _connectionManager: ConnectionManager,
    private readonly networkConfig: NetworkConfig
  ) {
    this.normalizer = new BlockchainNormalizer(this.networkConfig);
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
        this.log.warn('Provider recovery failed', {
          args: { methodName, originalError: error, recoveryError },
        });
        throw recoveryError;
      }
    }
  }

  /**
   * Enhanced subscription method with trie verification support
   * Subscribes to new block events via WebSocket using provider's native implementation
   * Returns complete blocks with transactions and receipts
   *
   * @param callback - Function to be invoked whenever a new block is received
   * @param fullTransactions - Whether to include full transaction objects
   * @param verifyTrie - Whether to verify merkle tries for transactions and receipts
   * @returns A Subscription (Promise<void> & { unsubscribe(): void })
   */
  public subscribeToNewBlocks(
    callback: (block: Block) => void,
    fullTransactions = true,
    verifyTrie = false
  ): Subscription {
    let resolveSubscription!: () => void;
    let rejectSubscription!: (error: Error) => void;

    const subscriptionPromise = new Promise<void>((resolve, reject) => {
      resolveSubscription = resolve;
      rejectSubscription = reject;
    }) as Subscription;

    this._connectionManager
      .getActiveProvider()
      .then((provider) => {
        if (!provider.hasWebSocketSupport || !provider.isWebSocketConnected) {
          const err = new Error('Active provider does not support WebSocket connections or WebSocket is not connected');
          rejectSubscription(err);
          return;
        }

        try {
          const subscription = provider.subscribeToNewBlocks(async (blockNumber: number) => {
            try {
              const blockWithReceipts = await this.getOneBlockWithReceipts(blockNumber, fullTransactions, verifyTrie);
              if (blockWithReceipts) {
                callback(blockWithReceipts);
              }
            } catch (error) {
              this.log.debug('Error fetching block in subscription', {
                args: { blockNumber, error },
                methodName: 'subscribeToNewBlocks()',
              });
              rejectSubscription(error as Error);
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
        this.log.debug('Failed to get provider', {
          args: { error },
          methodName: 'subscribeToNewBlocks()',
        });
        rejectSubscription(error as Error);
      });

    return subscriptionPromise;
  }

  /**
   * Gets a block with full transactions and all receipts using eth_getBlockReceipts.
   * Optimized approach: get block + transactions, then get all receipts with one call.
   * Guarantees blockNumber since height is known from request.
   * Node calls: 2 (1 for block + 1 for receipts if block has transactions, otherwise just 1)
   */
  public async getOneBlockWithReceipts(
    height: string | number,
    fullTransactions = false,
    verifyTrie = false
  ): Promise<Block | null> {
    return this.executeProviderMethod('getOneBlockWithReceipts', async (provider) => {
      const numericHeight = Number(height);

      // Use the new unified method from provider
      const blocksWithReceipts = await provider.getManyBlocksWithReceipts(
        [numericHeight],
        fullTransactions,
        verifyTrie
      );

      if (!blocksWithReceipts || blocksWithReceipts.length === 0 || !blocksWithReceipts[0]) {
        return null;
      }

      const rawBlock = blocksWithReceipts[0];

      // Ensure blockNumber is present - required for final Block interface
      if (rawBlock.blockNumber === undefined || rawBlock.blockNumber === null) {
        rawBlock.blockNumber = numericHeight;
      }

      const normalizedBlock = this.normalizer.normalizeBlock(rawBlock);
      return normalizedBlock;
    });
  }

  /**
   * Gets multiple blocks with full transactions and receipts using the provider's unified method.
   * Optimized approach using batch calls for better performance.
   * Guarantees blockNumber since heights are known from request.
   * Node calls: 2 (1 batch for blocks + 1 batch for receipts)
   */
  public async getManyBlocksWithReceipts(
    heights: string[] | number[],
    fullTransactions = false,
    verifyTrie = false
  ): Promise<Block[]> {
    return this.executeProviderMethod('getManyBlocksWithReceipts', async (provider) => {
      // Use the new unified method from provider
      const rawBlocksWithReceipts = await provider.getManyBlocksWithReceipts(heights, fullTransactions, verifyTrie);

      // Filter out null blocks and normalize
      const validBlocks = rawBlocksWithReceipts.filter((block: any): block is UniversalBlock => block !== null);

      const normalizedBlocks = validBlocks.map((rawBlock: any) => this.normalizer.normalizeBlock(rawBlock));

      return normalizedBlocks;
    });
  }

  /**
   * Merges receipts into blocks that already have transactions loaded.
   * This method is optimized for memory efficiency by modifying blocks in place.
   */
  public async mergeReceiptsIntoBlocks(blocks: Block[], receipts: TransactionReceipt[]): Promise<Block[]> {
    try {
      const blockTxMapping = new Map<number, string[]>();

      blocks.forEach((block: Block) => {
        if (block.transactions && block.transactions.length > 0) {
          const txHashes = block.transactions.map((tx: any) => (typeof tx === 'string' ? tx : tx.hash));
          blockTxMapping.set(block.blockNumber, txHashes);
        } else {
          blockTxMapping.set(block.blockNumber, []);
        }
      });

      let receiptIndex = 0;

      for (const block of blocks) {
        const txHashes = blockTxMapping.get(block.blockNumber) || [];

        if (txHashes.length > 0) {
          (block as any).receipts = receipts.slice(receiptIndex, receiptIndex + txHashes.length);
          receiptIndex += txHashes.length;
        } else {
          (block as any).receipts = [];
        }

        block.sizeWithoutReceipts = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);

        if (block.receipts && block.receipts.length > 0) {
          const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts);
          block.size = block.sizeWithoutReceipts + receiptsSize;
        } else {
          block.size = block.sizeWithoutReceipts;
        }
      }

      return blocks;
    } catch (error) {
      this.log.debug('Failed to merge receipts into blocks', {
        args: { blockCount: blocks.length, receiptsCount: receipts.length, error },
        methodName: 'mergeReceiptsIntoBlocks()',
      });
      throw error;
    }
  }

  /**
   * Gets the current block height
   * Node calls: 1 (eth_blockNumber)
   */
  public async getCurrentBlockHeight(): Promise<number> {
    return this.executeProviderMethod('getCurrentBlockHeight', async (provider) => {
      const height = await provider.getBlockHeight();
      return Number(height);
    });
  }

  /**
   * Gets a block hash by height.
   * Guarantees blockNumber since height is known from request.
   * Node calls: 1 (eth_getBlockByNumber with fullTransactions=false)
   */
  public async getOneBlockHashByHeight(height: string | number): Promise<string | null> {
    return this.executeProviderMethod('getOneBlockHashByHeight', async (provider) => {
      const rawBlocks = await provider.getManyBlocksByHeights([Number(height)], false);

      if (!rawBlocks || rawBlocks.length === 0 || !rawBlocks[0]) {
        return null;
      }

      return rawBlocks[0].hash;
    });
  }

  /**
   * Gets a normalized block by height.
   * Guarantees blockNumber since height is known from request.
   * Node calls: 1 (eth_getBlockByNumber)
   */
  public async getOneBlockByHeight(
    height: string | number,
    fullTransactions?: boolean,
    verifyTrie?: boolean
  ): Promise<Block | null> {
    return this.executeProviderMethod('getOneBlockByHeight', async (provider) => {
      const numericHeight = Number(height);
      const rawBlocks = await provider.getManyBlocksByHeights([numericHeight], fullTransactions, verifyTrie);

      if (!rawBlocks || rawBlocks.length === 0 || !rawBlocks[0]) {
        return null;
      }

      const rawBlock = rawBlocks[0];
      return this.normalizer.normalizeBlock(rawBlock);
    });
  }

  /**
   * Gets multiple normalized blocks by heights using batch calls for better performance.
   * Guarantees blockNumber since heights are known from request.
   * Node calls: 1 (batch eth_getBlockByNumber for all heights)
   */
  public async getManyBlocksByHeights(
    heights: string[] | number[],
    fullTransactions?: boolean,
    verifyTrie?: boolean
  ): Promise<Block[]> {
    return this.executeProviderMethod('getManyBlocksByHeights', async (provider) => {
      const numericHeights = heights.map((item) => Number(item));
      const rawBlocks = await provider.getManyBlocksByHeights(numericHeights, fullTransactions, verifyTrie);

      // Filter out null blocks and normalize
      const validBlocks = rawBlocks.filter((block: any): block is UniversalBlock => block !== null);
      return validBlocks.map((rawBlock: any) => this.normalizer.normalizeBlock(rawBlock));
    });
  }

  /**
   * Gets block statistics by heights using batch calls.
   * Guarantees blockNumber since heights are known from request.
   * Node calls: 1 (batch eth_getBlockByNumber with fullTransactions=false for all heights)
   */
  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<any[]> {
    return this.executeProviderMethod('getManyBlocksStatsByHeights', async (provider) => {
      const rawStats = await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));

      // Filter out null stats
      return rawStats.filter((stats: any) => stats !== null);
    });
  }

  /**
   * Gets a normalized block by hash.
   * Does NOT guarantee blockNumber - needs additional request to get heights if missing.
   * Node calls: 1-2 (eth_getBlockByHash + eth_blockNumber if blockNumber missing)
   */
  public async getOneBlockByHash(hash: string | Hash, fullTransactions?: boolean): Promise<Block | null> {
    return this.executeProviderMethod('getOneBlockByHash', async (provider) => {
      const rawBlocks = await provider.getManyBlocksByHashes([hash as Hash], fullTransactions);

      if (!rawBlocks || rawBlocks.length === 0 || !rawBlocks[0]) {
        return null;
      }

      let rawBlock = rawBlocks[0];

      // If blockNumber is missing, we need to get it from the provider
      if (rawBlock.blockNumber === undefined || rawBlock.blockNumber === null) {
        this.log.debug('Block retrieved by hash missing blockNumber field, fetching current height', {
          args: { hash },
          methodName: 'getOneBlockByHash()',
        });

        // Get current height as fallback - this is not ideal but prevents crashes
        const currentHeight = await provider.getBlockHeight();
        rawBlock.blockNumber = currentHeight;
      }

      return this.normalizer.normalizeBlock(rawBlock);
    });
  }

  /**
   * Gets multiple normalized blocks by hashes using batch calls.
   * Does NOT guarantee blockNumber - needs additional requests to get heights if missing.
   * Node calls: 1-2 (batch eth_getBlockByHash + eth_blockNumber if any blockNumbers missing)
   */
  public async getManyBlocksByHashes(hashes: string[] | Hash[], fullTransactions?: boolean): Promise<Block[]> {
    return this.executeProviderMethod('getManyBlocksByHashes', async (provider) => {
      const rawBlocks = await provider.getManyBlocksByHashes(hashes as Hash[], fullTransactions);

      // Check for missing blockNumbers and handle them
      const blocksNeedingHeight: number[] = [];
      const validBlocks: UniversalBlock[] = [];

      rawBlocks.forEach((rawBlock: any, index: any) => {
        if (rawBlock) {
          if (rawBlock.blockNumber === undefined || rawBlock.blockNumber === null) {
            blocksNeedingHeight.push(index);
            this.log.debug('Block retrieved by hash missing blockNumber field', {
              args: { hash: rawBlock.hash },
              methodName: 'getManyBlocksByHashes()',
            });
          }
          validBlocks.push(rawBlock);
        }
      });

      // If some blocks are missing blockNumber, get current height as fallback
      if (blocksNeedingHeight.length > 0) {
        const currentHeight = await provider.getBlockHeight();
        blocksNeedingHeight.forEach((index) => {
          const block = validBlocks.find((b) => b === rawBlocks[index]);
          if (block) {
            block.blockNumber = currentHeight;
          }
        });
      }

      return validBlocks.map((rawBlock: any) => this.normalizer.normalizeBlock(rawBlock));
    });
  }

  /**
   * Utility method to check if a feature is supported by the current network
   */
  public isFeatureSupported(feature: 'eip1559' | 'withdrawals' | 'blobTransactions'): boolean {
    switch (feature) {
      case 'eip1559':
        return this.networkConfig.hasEIP1559;
      case 'withdrawals':
        return this.networkConfig.hasWithdrawals;
      case 'blobTransactions':
        return this.networkConfig.hasBlobTransactions;
      default:
        return false;
    }
  }

  /**
   * Gets the native currency symbol for the current network
   */
  public getNativeCurrencySymbol(): string {
    return this.networkConfig.nativeCurrencySymbol;
  }

  /**
   * Gets the native currency decimals for the current network
   */
  public getNativeCurrencyDecimals(): number {
    return this.networkConfig.nativeCurrencyDecimals;
  }

  /**
   * Gets the chain ID for the current network
   */
  public getChainId(): number {
    return this.networkConfig.chainId;
  }
}
