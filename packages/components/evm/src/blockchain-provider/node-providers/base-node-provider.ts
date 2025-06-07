import type { Hash } from './interfaces';

export interface BaseNodeProviderOptions {
  uniqName: string;
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

  async sendTransaction(transaction: any): Promise<any> {
    throw new Error('Method sendTransaction() is not supported by this provider');
  }

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() is not supported by this provider');
  }

  async getOneBlockByHeight(height: number, fullTransactions?: boolean): Promise<any> {
    throw new Error('Method getOneBlockByHeight() is not supported by this provider');
  }

  public async getOneBlockHashByHeight(height: number): Promise<any> {
    throw new Error('Method getOneBlockHashByHeight() is not supported by this provider');
  }

  async getManyBlocksByHeights(heights: number[], fullTransactions?: boolean): Promise<any> {
    throw new Error('Method getManyBlocksByHeight() is not supported by this provider');
  }

  async getManyBlocksStatsByHeights(heights: number[]): Promise<any> {
    throw new Error('Method getManyBlocksStatsByHeights() is not supported by this provider');
  }

  async getOneBlockByHash(hash: Hash, fullTransactions?: boolean): Promise<any> {
    throw new Error('Method getOneBlockByHash() is not supported by this provider');
  }

  async getManyBlocksByHashes(hashes: Hash[], fullTransactions?: boolean): Promise<any> {
    throw new Error('Method getManyBlockByHash() is not supported by this provider');
  }

  async getOneTransactionByHash(hash: Hash): Promise<any> {
    throw new Error('Method getOneTransactionByHash() is not supported by this provider');
  }

  async getManyTransactionsByHashes(hash: Hash[]): Promise<any> {
    throw new Error('Method getManyTransactionsByHashes() is not supported by this provider');
  }
}
