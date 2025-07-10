import type { Hash, RateLimits } from './interfaces';
import type {
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalBlockStats,
} from './interfaces';

export interface BaseNodeProviderOptions {
  uniqName: string;
  /** Rate limiting configuration */
  rateLimits: RateLimits;
}

export abstract class BaseNodeProvider<T extends BaseNodeProviderOptions = BaseNodeProviderOptions>
  implements BaseNodeProviderOptions
{
  abstract type: string;
  uniqName: string;
  protected _httpClient: any;
  protected _wsClient?: any;
  rateLimits: RateLimits;

  constructor({ uniqName, rateLimits }: T) {
    this.uniqName = uniqName;
    this.rateLimits = rateLimits;
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

  /**
   * Subscribes to new block events via WebSocket
   * Returns a subscription object with unsubscribe method
   * Throws error by default for providers that don't support WebSocket subscriptions
   */
  subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe: () => void } {
    throw new Error('Method subscribeToNewBlocks() is not supported by this provider');
  }

  /**
   * Gets receipts for multiple blocks using batch eth_getBlockReceipts calls
   */
  async getManyBlocksReceipts(blockNumbers: number[]): Promise<UniversalTransactionReceipt[][]> {
    throw new Error('Method getManyBlocksReceipts() is not supported by this provider');
  }

  // ===== BLOCK METHODS =====

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() is not supported by this provider');
  }

  async getManyBlocksByHeights(heights: number[], fullTransactions?: boolean): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHeights() is not supported by this provider');
  }

  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    throw new Error('Method getManyBlocksStatsByHeights() is not supported by this provider');
  }

  async getManyBlocksByHashes(hashes: Hash[], fullTransactions?: boolean): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHashes() is not supported by this provider');
  }
}
