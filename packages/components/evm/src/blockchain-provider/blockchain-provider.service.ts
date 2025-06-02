import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import { Hash } from './node-providers';

/**
 * A Subscription is a Promise that resolves once unsubscribed, and also provides
 * an `unsubscribe()` method to cancel the underlying WebSocket listener.
 */
export type Subscription = Promise<void> & { unsubscribe: () => void };

@Injectable()
export class BlockchainProviderService {
  constructor(
    private readonly log: AppLogger,
    private readonly _connectionManager: ConnectionManager
  ) {}

  get connectionManager() {
    return this._connectionManager;
  }

  /**
   * Subscribes to new block events via WebSocket. Returns a Subscription object,
   * which is a Promise that will not resolve until `unsubscribe()` is called,
   * or will reject if an error occurs while fetching or processing a block.
   *
   * @param callback - A function to be invoked whenever a new block is received.
   *                   The block data is fetched (with full transactions) before calling this callback.
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
  public subscribeToNewBlocks(callback: (block: any) => void): Subscription {
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
            const block = await provider.getOneBlockByHeight(blockNumber, true);
            // Invoke the user-provided callback with the block data
            callback(block);
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

  public async getOneBlockHashByHeight(height: string | number): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getOneBlockHashByHeight(Number(height));
    } catch (error) {
      this.log.error('getOneBlockHashByHeight()', { args: error });
      throw error;
    }
  }

  public async getOneBlockByHeight(height: string | number, fullTransactions?: boolean): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getOneBlockByHeight(Number(height), fullTransactions);
    } catch (error) {
      this.log.error('getOneBlockByHeight()', { args: error });
      throw error;
    }
  }

  public async getManyBlocksByHeights(heights: string[] | number[], fullTransactions?: boolean): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getManyBlocksByHeights(
        heights.map((item) => Number(item)),
        fullTransactions
      );
    } catch (error) {
      this.log.error('getManyBlocksByHeights()', { args: error });
      throw error;
    }
  }

  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      return await provider.getManyBlocksStatsByHeights(heights.map((item) => Number(item)));
    } catch (error) {
      this.log.error('getManyBlocksStatsByHeights()', { args: error });
      throw error;
    }
  }

  public async getOneBlockByHash(hash: string | Hash, fullTransactions?: boolean): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      return await provider.getOneBlockByHash(hash as Hash, fullTransactions);
    } catch (error) {
      this.log.error('getOneBlockByHash()', { args: error });
      throw error;
    }
  }

  public async getManyBlocksByHashes(hashes: string[] | Hash[], fullTransactions?: boolean): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      const blocks = await provider.getManyBlocksByHashes(hashes as Hash[], fullTransactions);
      return blocks.filter((block: any) => block);
    } catch (error) {
      this.log.error('getManyBlocksByHashes()', { args: error });
      throw error;
    }
  }

  public async getOneTransactionByHash(hash: string | Hash): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      return await provider.getOneTransactionByHash(hash as Hash);
    } catch (error) {
      this.log.error('getOneTransactionByHash()', { args: error });
      throw error;
    }
  }

  public async getManyTransactionsByHashes(hashes: string[] | Hash[]): Promise<any> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      // TODO: add method transform into Hash
      return await provider.getManyTransactionsByHashes(hashes as Hash[]);
    } catch (error) {
      this.log.error('getManyTransactionsByHashes()', { args: error });
      throw error;
    }
  }
}
