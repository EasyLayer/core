import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { ConnectionManager } from './connection-manager';
import { Hash } from './node-providers';

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

  public async subscribeToNewBlocks(callback: (block: any) => void): Promise<Subscription> {
    try {
      const provider = await this._connectionManager.getActiveProvider();
      if (!provider.wsClient) {
        throw new Error('Active provider does not support WebSocket connections');
      }

      let resolveSubscription: () => void;
      let rejectSubscription: (error: Error) => void;

      // Create a promise that will not be resolved until resolveSubscription or rejectSubscription is called
      const subscriptionPromise = new Promise<void>((resolve, reject) => {
        resolveSubscription = resolve;
        rejectSubscription = reject;
      });

      const listener = async (blockNumber: number) => {
        try {
          const block = await provider.getOneBlockByHeight(blockNumber, true);
          callback(block);
        } catch (error) {
          this.log.error('Error fetching block', { args: error });
          // If an error occurs while processing the block, we reject the promise
          rejectSubscription(error as Error);
        }
      };

      // Register a listener for the "block" event
      provider.wsClient.on('block', listener);

      // "Hook" the unsubscribe function to the promise:
      // When someone calls unsubscribe, we remove the listener and resolve the promise,
      // allowing the await to complete.
      (subscriptionPromise as any).unsubscribe = () => {
        provider.wsClient.off('block', listener);
        resolveSubscription();
      };

      // Return a promise that will never resolve unless unsubscribe is called or an error occurs.
      return subscriptionPromise as Subscription;
    } catch (error) {
      this.log.error('subscribeToNewBlocks()', { args: error });
      throw error;
    }
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
