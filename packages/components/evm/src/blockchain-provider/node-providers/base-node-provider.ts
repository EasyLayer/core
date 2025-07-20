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

  // Track WebSocket availability and status
  protected _hasWebSocketUrl: boolean = false;
  protected _isWebSocketConnected: boolean = false;

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

  /**
   * Indicates if this provider has WebSocket support configured
   */
  get hasWebSocketSupport(): boolean {
    return this._hasWebSocketUrl;
  }

  /**
   * Indicates if WebSocket is currently connected
   */
  get isWebSocketConnected(): boolean {
    return this._hasWebSocketUrl && this._isWebSocketConnected;
  }

  abstract get connectionOptions(): T;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  /**
   * Handle connection errors and attempt recovery
   * This method should be called whenever a request fails
   */
  abstract handleConnectionError(error: any, methodName: string): Promise<void>;

  /**
   * Basic HTTP health check - only used for initial connection validation
   * Should not be called repeatedly to avoid burning credits
   */
  abstract healthcheck(): Promise<boolean>;

  /**
   * Checks if WebSocket connection is healthy by checking connection state
   * Does not make actual requests to avoid costs
   */
  healthcheckWebSocket(): boolean {
    if (!this._hasWebSocketUrl) {
      return false;
    }

    // Check WebSocket connection state without making requests
    if (!this._wsClient) {
      return false;
    }

    // Provider-specific WebSocket state checking should be implemented in subclasses
    return this._isWebSocketConnected;
  }

  /**
   * Reconnects WebSocket connection
   * Only available for providers that support WebSocket
   */
  async reconnectWebSocket(): Promise<void> {
    if (!this._hasWebSocketUrl) {
      throw new Error('WebSocket is not configured for this provider');
    }
    throw new Error('Method reconnectWebSocket() must be implemented by provider');
  }

  /**
   * Subscribes to new block events via WebSocket
   * Returns a subscription object with unsubscribe method
   * Only available for providers that support WebSocket
   */
  subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe: () => void } {
    if (!this._hasWebSocketUrl) {
      throw new Error('WebSocket is not configured for this provider');
    }
    throw new Error('Method subscribeToNewBlocks() must be implemented by provider');
  }

  /**
   * Gets receipts for multiple blocks using batch eth_getBlockReceipts calls
   */
  async getManyBlocksReceipts(blockNumbers: number[]): Promise<UniversalTransactionReceipt[][]> {
    throw new Error('Method getManyBlocksReceipts() must be implemented by provider');
  }

  // ===== BLOCK METHODS =====

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() must be implemented by provider');
  }

  async getManyBlocksByHeights(heights: number[], fullTransactions?: boolean): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHeights() must be implemented by provider');
  }

  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    throw new Error('Method getManyBlocksStatsByHeights() must be implemented by provider');
  }

  async getManyBlocksByHashes(hashes: Hash[], fullTransactions?: boolean): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHashes() must be implemented by provider');
  }
}
