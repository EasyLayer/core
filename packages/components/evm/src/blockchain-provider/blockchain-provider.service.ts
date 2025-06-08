import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import type { Hash, NetworkConfig } from './node-providers';
import { BlockchainNormalizer } from './normalizer';
import { Block, Transaction, TransactionReceipt } from './components';

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
   * Subscribes to new block events via WebSocket. Returns a Subscription object,
   * which is a Promise that will not resolve until `unsubscribe()` is called,
   * or will reject if an error occurs while fetching or processing a block.
   *
   * @param callback - A function to be invoked whenever a new block is received.
   *                   The block data is fetched (with full transactions) and normalized before calling this callback.
   * @returns A Subscription (Promise<void> & { unsubscribe(): void }). Calling unsubscribe()
   *          removes the WebSocket listener and resolves the promise, allowing callers to clean up.
   *
   * @example
   * ```ts
   * const subscription = blockchainProviderService.subscribeToNewBlocks((block) => {
   *   console.log('Received new block:', block);
   * });
   *
   * // Later, to stop listening:
   * subscription.unsubscribe();
   * await subscription; // resolves once the listener is removed
   * ```
   */
  public subscribeToNewBlocks(callback: (block: Block) => void): Subscription {
    let resolveSubscription!: () => void;
    let rejectSubscription!: (error: Error) => void;

    // Create the underlying promise, then cast it to Subscription so we can attach unsubscribe().
    const subscriptionPromise = new Promise<void>((resolve, reject) => {
      resolveSubscription = resolve;
      rejectSubscription = reject;
    }) as Subscription;

    // Asynchronously retrieve the active provider
    this._connectionManager
      .getActiveProvider()
      .then((provider) => {
        if (!provider.wsClient) {
          // If WebSocket client is not available, immediately reject the subscription promise
          const err = new Error('Active provider does not support WebSocket connections');
          rejectSubscription(err);
          return;
        }

        // Define a listener that fires on each "block" event
        const listener = async (blockNumber: number) => {
          try {
            // Fetch the full block (including transactions) by height
            const rawBlock = await provider.getOneBlockByHeight(blockNumber, true);

            // Normalize the block data before passing to callback
            const normalizedBlock = this.normalizer.normalizeBlock(rawBlock);

            // Invoke the user-provided callback with the normalized block data
            callback(normalizedBlock);
          } catch (error) {
            this.log.error('Error fetching block', { args: error });
            // If fetching or processing the block fails, reject the subscription promise
            rejectSubscription(error as Error);
          }
        };

        // Register the listener for new block events
        provider.wsClient.on('block', listener);

        // Attach unsubscribe() to our subscriptionPromise to remove the listener and resolve the promise
        subscriptionPromise.unsubscribe = () => {
          provider.wsClient.off('block', listener);
          resolveSubscription();
        };
      })
      .catch((error) => {
        // If retrieving the active provider fails, reject the subscription promise
        this.log.error('subscribeToNewBlocks(): failed to get provider', { args: error });
        rejectSubscription(error as Error);
      });

    // Return the Subscription (Promise<void> & { unsubscribe(): void })
    return subscriptionPromise;
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
      this.log.error('getCurrentBlockHeight()', { args: error });
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
      this.log.error('getOneBlockHashByHeight()', { args: error });
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
      this.log.error('getOneBlockByHeight()', { args: error });
      throw error;
    }
  }

  /**
   * Gets multiple normalized blocks by heights
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
      this.log.error('getManyBlocksByHeights()', { args: error });
      throw error;
    }
  }

  /**
   * Gets block statistics by heights (returns raw data as stats don't need normalization)
   */
  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));
    } catch (error) {
      this.log.error('getManyBlocksStatsByHeights()', { args: error });
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
      this.log.error('getOneBlockByHash()', { args: error });
      throw error;
    }
  }

  /**
   * Gets multiple normalized blocks by hashes
   */
  public async getManyBlocksByHashes(hashes: string[] | Hash[], fullTransactions?: boolean): Promise<Block[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawBlocks = await provider.getManyBlocksByHashes(hashes as Hash[], fullTransactions);

      // Filter out null blocks and normalize the rest
      return rawBlocks.filter((block: any) => block).map((rawBlock: any) => this.normalizer.normalizeBlock(rawBlock));
    } catch (error) {
      this.log.error('getManyBlocksByHashes()', { args: error });
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
      this.log.error('getOneTransactionByHash()', { args: error });
      throw error;
    }
  }

  /**
   * Gets multiple normalized transactions by hashes
   */
  public async getManyTransactionsByHashes(hashes: string[] | Hash[]): Promise<Transaction[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawTransactions = await provider.getManyTransactionsByHashes(hashes as Hash[]);

      // Normalize all transactions
      return rawTransactions.map((rawTx: any) => this.normalizer.normalizeTransaction(rawTx));
    } catch (error) {
      this.log.error('getManyTransactionsByHashes()', { args: error });
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
      this.log.error('getTransactionReceipt()', { args: error });
      throw error;
    }
  }

  /**
   * Gets multiple normalized transaction receipts by hashes
   */
  public async getManyTransactionReceipts(hashes: string[] | Hash[]): Promise<TransactionReceipt[]> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      const rawReceipts = await provider.getManyTransactionReceipts(hashes as Hash[]);

      // Normalize all receipts
      return rawReceipts.map((rawReceipt: any) => this.normalizer.normalizeTransactionReceipt(rawReceipt));
    } catch (error) {
      this.log.error('getManyTransactionReceipts()', { args: error });
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
