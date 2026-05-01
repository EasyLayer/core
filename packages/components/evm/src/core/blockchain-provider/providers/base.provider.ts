import type {
  Hash,
  RateLimits,
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalBlockStats,
  UniversalTrace,
  MempoolTxMetadata,
} from './interfaces';

export interface BaseNodeProviderOptions {
  uniqName: string;
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
  get hasWebSocketSupport(): boolean {
    return this._hasWebSocketUrl;
  }
  get isWebSocketConnected(): boolean {
    return this._hasWebSocketUrl && this._isWebSocketConnected;
  }

  abstract get connectionOptions(): T;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract handleConnectionError(error: any, methodName: string): Promise<void>;
  abstract healthcheck(): Promise<boolean>;

  healthcheckWebSocket(): boolean {
    if (!this._hasWebSocketUrl) return false;
    return this._isWebSocketConnected;
  }

  abstract reconnectWebSocket(): Promise<void>;

  abstract subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe(): void };

  // ===== BLOCK METHODS =====
  abstract getBlockHeight(): Promise<number>;
  abstract getManyBlocksByHeights(
    heights: number[],
    fullTransactions?: boolean,
    verifyTrie?: boolean
  ): Promise<(UniversalBlock | null)[]>;
  abstract getManyBlocksByHashes(hashes: Hash[], fullTransactions?: boolean): Promise<(UniversalBlock | null)[]>;
  abstract getManyBlocksWithReceipts(
    heights: number[],
    fullTransactions?: boolean,
    verifyTrie?: boolean
  ): Promise<(UniversalBlock | null)[]>;
  abstract getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]>;

  // ===== TRACE METHODS =====
  /**
   * Returns traces for a block by height.
   * Tries debug_traceBlockByNumber (Geth) then trace_block (Erigon/OpenEthereum).
   * Fails if node does not support trace APIs.
   */
  abstract assertTraceSupport(): Promise<void>;
  abstract getTracesByBlockNumber(blockNumber: number): Promise<UniversalTrace[]>;

  /**
   * Returns traces for a single transaction.
   * Tries debug_traceTransaction (Geth) then trace_transaction (Erigon).
   * Fails if node does not support trace APIs.
   */
  abstract getTracesByTxHash(hash: string): Promise<UniversalTrace[]>;

  // ===== MEMPOOL METHODS =====
  /**
   * Subscribes to newPendingTransactions via WebSocket.
   * Returns an object with unsubscribe() method.
   * Throws if WebSocket is not available.
   */
  abstract subscribeToPendingTransactions(callback: (txHash: string) => void): { unsubscribe(): void };

  /**
   * Returns raw mempool via txpool_content (Geth/Erigon-specific).
   * Returns {} if not supported by node.
   */
  abstract getRawMempool(): Promise<Record<string, any>>;

  /**
   * Fetch a pending (or recently mined) transaction by hash.
   * Returns null if not found.
   */
  abstract getTransactionByHash(hash: string): Promise<UniversalTransaction | null>;
}
