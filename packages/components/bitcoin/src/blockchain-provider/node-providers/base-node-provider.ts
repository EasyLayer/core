import type {
  RateLimits,
  UniversalBlock,
  UniversalBlockStats,
  UniversalTransaction,
  UniversalMempoolTransaction,
  UniversalMempoolInfo,
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
  protected _httpClient: any;
  uniqName: string;
  rateLimits: RateLimits;

  constructor({ uniqName, rateLimits }: T) {
    this.uniqName = uniqName;
    this.rateLimits = rateLimits;
  }

  get httpClient() {
    return this._httpClient;
  }

  abstract get connectionOptions(): T;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  /**
   * Basic HTTP health check - only used for initial connection validation
   * Should not be called repeatedly to avoid burning resources
   */
  abstract healthcheck(): Promise<boolean>;

  /**
   * Handle connection errors and attempt recovery
   * This method should be called whenever a request fails
   */
  async handleConnectionError(error: any, methodName: string): Promise<void> {
    // Re-throw to let connection manager handle provider switching
    throw error;
  }

  // ===== BASIC BLOCKCHAIN METHODS =====

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() must be implemented by provider');
  }

  async getManyBlockHashesByHeights(heights: number[]): Promise<string[]> {
    throw new Error('Method getManyHashesByHeights() must be implemented by provider');
  }

  // ===== HEX METHODS (parse hex and return Universal* with hex field) =====

  // ATOMIC METHOD - must be implemented by all providers
  async getManyBlocksHexByHashes(hashes: string[]): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksHexByHashes() must be implemented by provider');
  }

  // COMBINED METHOD - optional, providers can implement for optimization
  async getManyBlocksHexByHeights(heights: number[]): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksHexByHeights() must be implemented by provider');
  }

  // ===== OBJECT METHODS (return Universal* without hex field) =====

  // ATOMIC METHOD - must be implemented by all providers
  async getManyBlocksByHashes(hashes: string[], verbosity?: number): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHashes() must be implemented by provider');
  }

  // COMBINED METHOD - optional, providers can implement for optimization
  async getManyBlocksByHeights(heights: number[], verbosity?: number): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHeights() must be implemented by provider');
  }

  // ===== BLOCK STATS METHODS =====

  // ATOMIC METHOD - must be implemented by all providers
  async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    throw new Error('Method getManyBlocksStatsByHashes() must be implemented by provider');
  }

  // COMBINED METHOD - optional, providers can implement for optimization
  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    throw new Error('Method getManyBlocksStatsByHeights() must be implemented by provider');
  }

  // ===== TRANSACTION HEX METHODS =====
  // ATOMIC METHOD - get transactions by txids as hex and parse to Universal objects
  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    throw new Error('Method getManyTransactionsHexByTxids() must be implemented by provider');
  }

  // ===== TRANSACTION OBJECT METHODS =====
  // ATOMIC METHOD - get transactions by txids as structured objects
  async getManyTransactionsByTxids(txids: string[], verbosity?: number): Promise<(UniversalTransaction | null)[]> {
    throw new Error('Method getManyTransactionsByTxids() must be implemented by provider');
  }

  // ===== NETWORK AND BLOCKCHAIN INFO METHODS =====

  async getBlockchainInfo(): Promise<any> {
    throw new Error('Method getBlockchainInfo() must be implemented by provider');
  }

  async getNetworkInfo(): Promise<any> {
    throw new Error('Method getNetworkInfo() must be implemented by provider');
  }

  async getMempoolInfo(): Promise<UniversalMempoolInfo> {
    throw new Error('Method getMempoolInfo() must be implemented by provider');
  }

  async getRawMempool(): Promise<any> {
    throw new Error('Method getRawMempool() must be implemented by provider');
  }

  async getMempoolEntries(txid: string[]): Promise<(UniversalMempoolTransaction | null)[]> {
    throw new Error('Method getMempoolEntries() must be implemented by provider');
  }

  async estimateSmartFee(confTarget: number, estimateMode?: string): Promise<any> {
    throw new Error('Method estimateSmartFee() must be implemented by provider');
  }
}
