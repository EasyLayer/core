import type { Hash, RateLimits } from './interfaces';
import type { UniversalBlock, UniversalTransaction, UniversalTransactionReceipt } from './interfaces';

export interface BaseNodeProviderOptions {
  uniqName: string;
  /** Rate limiting configuration */
  rateLimits?: RateLimits;
}

export abstract class BaseNodeProvider<T extends BaseNodeProviderOptions = BaseNodeProviderOptions>
  implements BaseNodeProviderOptions
{
  abstract type: string;
  uniqName: string;
  protected _httpClient: any;
  protected _wsClient?: any;

  constructor({ uniqName }: T) {
    this.uniqName = uniqName;
  }

  get httpClient() {
    return this._httpClient;
  }

  get wsClient() {
    return this._wsClient;
  }

  abstract get connectionOptions(): T;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthcheck(): Promise<boolean>;

  /**
   * Checks if WebSocket connection is healthy.
   * Returns false by default for providers that don't support WebSocket.
   */
  async healthcheckWebSocket(): Promise<boolean> {
    return false;
  }

  /**
   * Reconnects WebSocket connection.
   * Throws error by default for providers that don't support WebSocket.
   */
  async reconnectWebSocket(): Promise<void> {
    throw new Error('Method reconnectWebSocket() is not supported by this provider');
  }

  // ===== SUBSCRIPTION METHODS =====

  /**
   * Subscribes to new block events via WebSocket
   * Returns a subscription object with unsubscribe method
   * Throws error by default for providers that don't support WebSocket subscriptions
   */
  subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe: () => void } {
    throw new Error('Method subscribeToNewBlocks() is not supported by this provider');
  }

  /**
   * Subscribes to pending transactions via WebSocket
   * Returns a subscription object with unsubscribe method
   * Throws error by default for providers that don't support WebSocket subscriptions
   */
  subscribeToPendingTransactions(callback: (txHash: string) => void): { unsubscribe: () => void } {
    throw new Error('Method subscribeToPendingTransactions() is not supported by this provider');
  }

  /**
   * Subscribes to contract logs via WebSocket
   * Returns a subscription object with unsubscribe method
   * Throws error by default for providers that don't support WebSocket subscriptions
   */
  subscribeToLogs(
    options: {
      address?: string | string[];
      topics?: (string | string[] | null)[];
    },
    callback: (log: any) => void
  ): { unsubscribe: () => void } {
    throw new Error('Method subscribeToLogs() is not supported by this provider');
  }

  // ===== TRANSACTION METHODS =====

  async sendTransaction(transaction: any): Promise<any> {
    throw new Error('Method sendTransaction() is not supported by this provider');
  }

  async getOneTransactionByHash(hash: Hash | string[]): Promise<UniversalTransaction> {
    throw new Error('Method getOneTransactionByHash() is not supported by this provider');
  }

  async getManyTransactionsByHashes(hashes: Hash[] | string[]): Promise<UniversalTransaction[]> {
    throw new Error('Method getManyTransactionsByHashes() is not supported by this provider');
  }

  async getTransactionReceipt(hash: Hash | string[]): Promise<UniversalTransactionReceipt> {
    throw new Error('Method getTransactionReceipt() is not supported by this provider');
  }

  async getManyTransactionReceipts(hashes: Hash[] | string[]): Promise<UniversalTransactionReceipt[]> {
    throw new Error('Method getManyTransactionReceipts() is not supported by this provider');
  }

  /**
   * Gets all transaction receipts for a block using eth_getBlockReceipts
   * More efficient than getting receipts individually
   */
  async getBlockReceipts(blockNumber: number | string): Promise<UniversalTransactionReceipt[]> {
    throw new Error('Method getBlockReceipts() is not supported by this provider');
  }

  /**
   * Gets receipts for multiple blocks using batch eth_getBlockReceipts calls
   */
  async getManyBlocksReceipts(blockNumbers: (number | string)[]): Promise<UniversalTransactionReceipt[][]> {
    throw new Error('Method getManyBlocksReceipts() is not supported by this provider');
  }

  // ===== BLOCK METHODS =====

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() is not supported by this provider');
  }

  async getOneBlockByHeight(height: number, fullTransactions?: boolean): Promise<UniversalBlock> {
    throw new Error('Method getOneBlockByHeight() is not supported by this provider');
  }

  public async getOneBlockHashByHeight(height: number): Promise<string> {
    throw new Error('Method getOneBlockHashByHeight() is not supported by this provider');
  }

  async getManyBlocksByHeights(heights: number[], fullTransactions?: boolean): Promise<UniversalBlock[]> {
    throw new Error('Method getManyBlocksByHeights() is not supported by this provider');
  }

  async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    throw new Error('Method getManyBlocksStatsByHeights() is not supported by this provider');
  }

  async getOneBlockByHash(hash: Hash, fullTransactions?: boolean): Promise<UniversalBlock> {
    throw new Error('Method getOneBlockByHash() is not supported by this provider');
  }

  async getManyBlocksByHashes(hashes: Hash[] | string[], fullTransactions?: boolean): Promise<UniversalBlock[]> {
    throw new Error('Method getManyBlocksByHashes() is not supported by this provider');
  }
}
