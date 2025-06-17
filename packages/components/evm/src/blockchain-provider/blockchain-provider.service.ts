import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import type { Hash, NetworkConfig, UniversalBlock } from './node-providers';
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
  private readonly normalizer: BlockchainNormalizer;

  constructor(
    private readonly log: AppLogger,
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
   * Subscribes to contract logs via WebSocket using provider's native implementation
   */
  public subscribeToLogs(
    options: {
      address?: string | string[];
      topics?: (string | string[] | null)[];
    },
    callback: (log: any) => void
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
        if (!provider.wsClient) {
          const err = new Error('Active provider does not support WebSocket connections');
          rejectSubscription(err);
          return;
        }

        try {
          // Use provider's unified subscription method
          const subscription = provider.subscribeToLogs(options, callback);

          // Attach unsubscribe method
          subscriptionPromise.unsubscribe = () => {
            subscription.unsubscribe();
            resolveSubscription();
          };
        } catch (error) {
          rejectSubscription(error as Error);
        }
      })
      .catch((error) => {
        this.log.error('subscribeToLogs(): failed to get provider', { args: { error } });
        rejectSubscription(error as Error);
      });

    return subscriptionPromise;
  }

  /**
   * Subscribes to new block events via WebSocket using provider's native implementation
   * Now uses eth_getBlockReceipts for better performance
   *
   * @param callback - Function to be invoked whenever a new block is received
   * @returns A Subscription (Promise<void> & { unsubscribe(): void })
   */
  public subscribeToNewBlocks(callback: (block: Block) => void): Subscription {
    let resolveSubscription!: () => void;
    let rejectSubscription!: (error: Error) => void;

    // Create the underlying promise
    const subscriptionPromise = new Promise<void>((resolve, reject) => {
      resolveSubscription = resolve;
      rejectSubscription = reject;
    }) as Subscription;

    // Asynchronously retrieve the active provider
    this._connectionManager
      .getActiveProvider()
      .then((provider) => {
        if (!provider.wsClient) {
          const err = new Error('Active provider does not support WebSocket connections');
          rejectSubscription(err);
          return;
        }

        try {
          // Use provider's unified subscription method
          const subscription = provider.subscribeToNewBlocks(async (blockNumber: number) => {
            try {
              // Use optimized method with eth_getBlockReceipts
              const blockWithReceipts = await this.getOneBlockWithReceipts(blockNumber, true);
              callback(blockWithReceipts);
            } catch (error) {
              this.log.error('Error fetching block in subscription', { args: { error } });
              rejectSubscription(error as Error);
            }
          });

          // Attach unsubscribe method
          subscriptionPromise.unsubscribe = () => {
            subscription.unsubscribe();
            resolveSubscription();
          };
        } catch (error) {
          rejectSubscription(error as Error);
        }
      })
      .catch((error) => {
        this.log.error('subscribeToNewBlocks(): failed to get provider', { args: { error } });
        rejectSubscription(error as Error);
      });

    return subscriptionPromise;
  }

  /**
   * Subscribes to pending transactions via WebSocket using provider's native implementation
   */
  public subscribeToPendingTransactions(callback: (txHash: string) => void): Subscription {
    let resolveSubscription!: () => void;
    let rejectSubscription!: (error: Error) => void;

    const subscriptionPromise = new Promise<void>((resolve, reject) => {
      resolveSubscription = resolve;
      rejectSubscription = reject;
    }) as Subscription;

    this._connectionManager
      .getActiveProvider()
      .then((provider) => {
        if (!provider.wsClient) {
          const err = new Error('Active provider does not support WebSocket connections');
          rejectSubscription(err);
          return;
        }

        try {
          // Use provider's unified subscription method
          const subscription = provider.subscribeToPendingTransactions(callback);

          // Attach unsubscribe method
          subscriptionPromise.unsubscribe = () => {
            subscription.unsubscribe();
            resolveSubscription();
          };
        } catch (error) {
          rejectSubscription(error as Error);
        }
      })
      .catch((error) => {
        this.log.error('subscribeToPendingTransactions(): failed to get provider', { args: { error } });
        rejectSubscription(error as Error);
      });

    return subscriptionPromise;
  }

  /**
   * Gets a block with full transactions and all receipts using eth_getBlockReceipts.
   * Optimized approach: get block + transactions, then get all receipts with one call.
   */
  public async getOneBlockWithReceipts(height: string | number, fullTransactions = false): Promise<Block> {
    try {
      const provider = await this._connectionManager.getActiveProvider();

      // Get block with full transactions
      const rawBlock = await provider.getOneBlockByHeight(Number(height), fullTransactions);

      // Get all receipts using eth_getBlockReceipts (much more efficient!)
      if (rawBlock.transactions && rawBlock.transactions.length > 0) {
        try {
          // Use the new eth_getBlockReceipts method for better performance
          const rawReceipts = await provider.getBlockReceipts(Number(height));
          rawBlock.receipts = rawReceipts;
        } catch (blockReceiptsError) {
          this.log.warn('eth_getBlockReceipts failed, falling back to individual receipt fetching', {
            args: { height, error: blockReceiptsError },
          });

          // Fallback to individual receipt fetching if eth_getBlockReceipts is not supported
          const txHashes = rawBlock.transactions.map((tx: any) => (typeof tx === 'string' ? tx : tx.hash));
          const rawReceipts = await provider.getManyTransactionReceipts(txHashes);
          rawBlock.receipts = rawReceipts;
        }
      } else {
        rawBlock.receipts = [];
      }

      // Normalize the complete block (including receipts)
      const normalizedBlock = this.normalizer.normalizeBlock(rawBlock);

      return normalizedBlock;
    } catch (error) {
      this.log.error('getOneBlockWithReceipts() failed', {
        args: { height, error },
      });
      throw error;
    }
  }

  /**
   * Gets multiple blocks with full transactions and receipts using eth_getBlockReceipts.
   * Optimized approach using batch calls for better performance.
   */
  public async getManyBlocksWithReceipts(heights: string[] | number[], fullTransactions = false): Promise<Block[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const numericHeights = heights.map((h) => Number(h));

      // Get all blocks with full transactions using batch calls
      const rawBlocks = await provider.getManyBlocksByHeights(numericHeights, fullTransactions);

      try {
        // Use the new eth_getBlockReceipts method for much better performance
        const allBlocksReceipts = await provider.getManyBlocksReceipts(numericHeights);

        // Map receipts back to blocks
        rawBlocks.forEach((rawBlock, index) => {
          rawBlock.receipts = allBlocksReceipts[index] || [];
        });
      } catch (blockReceiptsError) {
        this.log.warn('getManyBlocksReceipts failed, falling back to individual receipt fetching', {
          args: { heights, error: blockReceiptsError },
        });

        // Fallback to individual receipt fetching if eth_getBlockReceipts is not supported
        const allTxHashes: string[] = [];
        const blockTxMapping = new Map<number, string[]>(); // blockNumber -> txHashes

        rawBlocks.forEach((rawBlock: UniversalBlock) => {
          if (rawBlock.transactions && rawBlock.transactions.length > 0) {
            const txHashes = rawBlock.transactions.map((tx: any) => (typeof tx === 'string' ? tx : tx.hash));
            blockTxMapping.set(rawBlock.blockNumber, txHashes);
            allTxHashes.push(...txHashes);
          } else {
            blockTxMapping.set(rawBlock.blockNumber, []);
          }
        });

        // Get all receipts at once using batch calls
        let allRawReceipts: any[] = [];
        if (allTxHashes.length > 0) {
          allRawReceipts = await provider.getManyTransactionReceipts(allTxHashes);
        }

        // Map receipts back to blocks
        let receiptIndex = 0;
        rawBlocks.forEach((rawBlock) => {
          const txHashes = blockTxMapping.get(rawBlock.blockNumber) || [];
          if (txHashes.length > 0) {
            rawBlock.receipts = allRawReceipts.slice(receiptIndex, receiptIndex + txHashes.length);
            receiptIndex += txHashes.length;
          } else {
            rawBlock.receipts = [];
          }
        });
      }

      // Normalize all blocks
      const normalizedBlocks = rawBlocks.map((rawBlock) => this.normalizer.normalizeBlock(rawBlock));

      return normalizedBlocks;
    } catch (error) {
      this.log.error('getManyBlocksWithReceipts() failed', {
        args: { heights, error },
      });
      throw error;
    }
  }

  /**
   * Merges receipts into blocks that already have transactions loaded.
   * This method is optimized for memory efficiency by modifying blocks in place.
   */
  public async mergeReceiptsIntoBlocks(blocks: Block[], receipts: TransactionReceipt[]): Promise<Block[]> {
    try {
      // Collect all transaction hashes from all blocks
      const blockTxMapping = new Map<number, string[]>(); // blockNumber -> txHashes

      blocks.forEach((block: Block) => {
        if (block.transactions && block.transactions.length > 0) {
          const txHashes = block.transactions.map((tx: any) => (typeof tx === 'string' ? tx : tx.hash));
          blockTxMapping.set(block.blockNumber, txHashes);
        } else {
          blockTxMapping.set(block.blockNumber, []);
        }
      });

      // Map receipts back to blocks in place to optimize memory
      let receiptIndex = 0;

      for (const block of blocks) {
        const txHashes = blockTxMapping.get(block.blockNumber) || [];

        // Add receipts directly to block to avoid copying
        if (txHashes.length > 0) {
          (block as any).receipts = receipts.slice(receiptIndex, receiptIndex + txHashes.length);
          receiptIndex += txHashes.length;
        } else {
          (block as any).receipts = [];
        }

        // Recalculate sizes with receipts using BlockSizeCalculator
        // Calculate size without receipts (original block + transactions)
        block.sizeWithoutReceipts = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);

        // Calculate total size including receipts
        if (block.receipts && block.receipts.length > 0) {
          const receiptsSize = BlockSizeCalculator.calculateReceiptsSize(block.receipts);
          block.size = block.sizeWithoutReceipts + receiptsSize;
        } else {
          // No receipts, so both sizes are the same
          block.size = block.sizeWithoutReceipts;
        }
      }

      return blocks;
    } catch (error) {
      this.log.error('mergeReceiptsIntoBlocks() failed', {
        args: { blockCount: blocks.length, receiptsCount: receipts.length, error },
      });
      throw error;
    }
  }

  /**
   * Gets the current block height
   */
  public async getCurrentBlockHeight(): Promise<number> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const height = await provider.getBlockHeight();
      return Number(height);
    } catch (error) {
      this.log.error('getCurrentBlockHeight()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets a block hash by height
   */
  public async getOneBlockHashByHeight(height: string | number): Promise<string> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getOneBlockHashByHeight(Number(height));
    } catch (error) {
      this.log.error('getOneBlockHashByHeight()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets a normalized block by height
   */
  public async getOneBlockByHeight(height: string | number, fullTransactions?: boolean): Promise<Block> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawBlock = await provider.getOneBlockByHeight(Number(height), fullTransactions);

      // Normalize the block data
      return this.normalizer.normalizeBlock(rawBlock);
    } catch (error) {
      this.log.error('getOneBlockByHeight()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets multiple normalized blocks by heights using batch calls for better performance
   */
  public async getManyBlocksByHeights(heights: string[] | number[], fullTransactions?: boolean): Promise<Block[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawBlocks = await provider.getManyBlocksByHeights(
        heights.map((item) => Number(item)),
        fullTransactions
      );

      // Normalize all blocks
      return rawBlocks.map((rawBlock: any) => this.normalizer.normalizeBlock(rawBlock));
    } catch (error) {
      this.log.error('getManyBlocksByHeights()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets block statistics by heights using batch calls
   */
  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));
    } catch (error) {
      this.log.error('getManyBlocksStatsByHeights()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets a normalized block by hash
   */
  public async getOneBlockByHash(hash: string | Hash, fullTransactions?: boolean): Promise<Block> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawBlock = await provider.getOneBlockByHash(hash as Hash, fullTransactions);

      // Normalize the block data
      return this.normalizer.normalizeBlock(rawBlock);
    } catch (error) {
      this.log.error('getOneBlockByHash()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets multiple normalized blocks by hashes using batch calls
   */
  public async getManyBlocksByHashes(hashes: string[] | Hash[], fullTransactions?: boolean): Promise<Block[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawBlocks = await provider.getManyBlocksByHashes(hashes as Hash[], fullTransactions);

      // Filter out null blocks and normalize the rest
      return rawBlocks.filter((block: any) => block).map((rawBlock: any) => this.normalizer.normalizeBlock(rawBlock));
    } catch (error) {
      this.log.error('getManyBlocksByHashes()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets a normalized transaction by hash
   */
  public async getOneTransactionByHash(hash: string | Hash): Promise<Transaction> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawTransaction = await provider.getOneTransactionByHash(hash as Hash);

      // Normalize the transaction data
      return this.normalizer.normalizeTransaction(rawTransaction);
    } catch (error) {
      this.log.error('getOneTransactionByHash()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets multiple normalized transactions by hashes using batch calls
   */
  public async getManyTransactionsByHashes(hashes: string[] | Hash[]): Promise<Transaction[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawTransactions = await provider.getManyTransactionsByHashes(hashes as Hash[]);

      // Normalize all transactions
      return rawTransactions.map((rawTx: any) => this.normalizer.normalizeTransaction(rawTx));
    } catch (error) {
      this.log.error('getManyTransactionsByHashes()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets a normalized transaction receipt by hash
   */
  public async getTransactionReceipt(hash: string | Hash): Promise<TransactionReceipt> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawReceipt = await provider.getTransactionReceipt(hash as Hash);

      // Normalize the receipt data
      return this.normalizer.normalizeTransactionReceipt(rawReceipt);
    } catch (error) {
      this.log.error('getTransactionReceipt()', { args: { error } });
      throw error;
    }
  }

  /**
   * Gets multiple normalized transaction receipts by hashes using batch calls
   */
  public async getManyTransactionReceipts(hashes: string[] | Hash[]): Promise<TransactionReceipt[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawReceipts = await provider.getManyTransactionReceipts(hashes as Hash[]);

      // Normalize all receipts
      return rawReceipts.map((rawReceipt: any) => this.normalizer.normalizeTransactionReceipt(rawReceipt));
    } catch (error) {
      this.log.error('getManyTransactionReceipts()', { args: { error } });
      throw error;
    }
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
