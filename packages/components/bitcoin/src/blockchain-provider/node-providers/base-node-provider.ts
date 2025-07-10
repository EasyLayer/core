import type { RateLimits, UniversalBlock, UniversalBlockStats, UniversalTransaction } from './interfaces';

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
  abstract healthcheck(): Promise<boolean>;

  // ===== BASIC BLOCKCHAIN METHODS =====

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() is not supported by this provider');
  }

  async getManyBlockHashesByHeights(heights: number[]): Promise<string[]> {
    throw new Error('Method getManyHashesByHeights() is not supported by this provider');
  }

  // ===== HEX METHODS (parse hex and return Universal* with hex field) =====

  // ATOMIC METHOD - must be implemented by all providers
  async getManyBlocksHexByHashes(hashes: string[]): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksHexByHashes() is not supported by this provider');
  }

  // COMBINED METHOD - optional, providers can implement for optimization
  async getManyBlocksHexByHeights(heights: number[]): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksHexByHeights() is not supported by this provider');
  }

  // ===== OBJECT METHODS (return Universal* without hex field) =====

  // ATOMIC METHOD - must be implemented by all providers
  async getManyBlocksByHashes(hashes: string[], verbosity?: number): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHashes() is not supported by this provider');
  }

  // COMBINED METHOD - optional, providers can implement for optimization
  async getManyBlocksByHeights(heights: number[], verbosity?: number): Promise<(UniversalBlock | null)[]> {
    throw new Error('Method getManyBlocksByHeights() is not supported by this provider');
  }

  // ===== BLOCK STATS METHODS =====

  // ATOMIC METHOD - must be implemented by all providers
  async getManyBlocksStatsByHashes(hashes: string[]): Promise<(UniversalBlockStats | null)[]> {
    throw new Error('Method getManyBlocksStatsByHashes() is not supported by this provider');
  }

  // COMBINED METHOD - optional, providers can implement for optimization
  async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    throw new Error('Method getManyBlocksStatsByHeights() is not supported by this provider');
  }

  // ===== TRANSACTION HEX METHODS =====
  // ATOMIC METHOD - get transactions by txids as hex and parse to Universal objects
  async getManyTransactionsHexByTxids(txids: string[]): Promise<(UniversalTransaction | null)[]> {
    throw new Error('Method getManyTransactionsHexByTxids() is not supported by this provider');
  }

  // ===== TRANSACTION OBJECT METHODS =====
  // ATOMIC METHOD - get transactions by txids as structured objects
  async getManyTransactionsByTxids(txids: string[], verbosity?: number): Promise<(UniversalTransaction | null)[]> {
    throw new Error('Method getManyTransactionsByTxids() is not supported by this provider');
  }

  // ===== NETWORK AND BLOCKCHAIN INFO METHODS =====

  async getBlockchainInfo(): Promise<any> {
    throw new Error('Method getBlockchainInfo() is not supported by this provider');
  }

  async getNetworkInfo(): Promise<any> {
    throw new Error('Method getNetworkInfo() is not supported by this provider');
  }

  async getMempoolInfo(): Promise<any> {
    throw new Error('Method getMempoolInfo() is not supported by this provider');
  }

  async getRawMempool(verbose?: boolean): Promise<any> {
    throw new Error('Method getRawMempool() is not supported by this provider');
  }

  async estimateSmartFee(confTarget: number, estimateMode?: string): Promise<any> {
    throw new Error('Method estimateSmartFee() is not supported by this provider');
  }
}
