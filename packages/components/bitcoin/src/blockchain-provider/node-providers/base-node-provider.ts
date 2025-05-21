import type { Hash } from './interfaces';

export interface BaseNodeProviderOptions {
  uniqName: string;
}

export abstract class BaseNodeProvider<T extends BaseNodeProviderOptions = BaseNodeProviderOptions>
  implements BaseNodeProviderOptions
{
  abstract type: string;
  uniqName: string;

  constructor({ uniqName }: T) {
    this.uniqName = uniqName;
  }

  abstract get connectionOptions(): T;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthcheck(): Promise<boolean>;

  async sendTransaction(transaction: any): Promise<any> {
    throw new Error('Method sendTransaction() is not supported by this provider');
  }

  async getBlockHeight(): Promise<number> {
    throw new Error('Method getBlockHeight() is not supported by this provider');
  }

  async getOneBlockByHeight(height: number, verbosity?: number): Promise<any> {
    throw new Error('Method getOneBlockByHeight() is not supported by this provider');
  }

  public async getOneBlockHashByHeight(height: number): Promise<any> {
    throw new Error('Method getOneBlockHashByHeight() is not supported by this provider');
  }

  async getManyBlocksByHeights(heights: number[], verbosity?: number): Promise<any> {
    throw new Error('Method getManyBlocksByHeight() is not supported by this provider');
  }

  async getManyBlocksStatsByHeights(heights: number[]): Promise<any> {
    throw new Error('Method getManyBlocksStatsByHeights() is not supported by this provider');
  }

  async getOneBlockByHash(hash: Hash, verbosity?: number): Promise<any> {
    throw new Error('Method getOneBlockByHash() is not supported by this provider');
  }

  async getManyBlocksByHashes(hashes: Hash[], verbosity?: number): Promise<any> {
    throw new Error('Method getManyBlockByHash() is not supported by this provider');
  }

  async getOneTransactionByHash(hash: Hash): Promise<any> {
    throw new Error('Method getOneTransactionByHash() is not supported by this provider');
  }

  async getManyTransactionsByHashes(hash: Hash[]): Promise<any> {
    throw new Error('Method getManyTransactionsByHashes() is not supported by this provider');
  }

  async handleWebhookStream(config: any): Promise<NodeJS.ReadWriteStream> {
    throw new Error('Method handleWebhookStream() is not supported by this provider');
  }

  async createWebhookStream(config: any): Promise<any> {
    throw new Error('Method createWebhookStream() is not supported by this provider');
  }

  async updateWebhookStream(streamId: string, config: any): Promise<any> {
    throw new Error('Method updateWebhookStream() is not supported by this provider');
  }

  async deleteWebhookStream(streamId: string): Promise<any> {
    throw new Error('Method deleteWebhookStream() is not supported by this provider');
  }

  async pauseWebhookStream(streamId: string): Promise<any> {
    throw new Error('Method pauseWebhookStream() is not supported by this provider');
  }

  async destroyWebhookStream(): Promise<void> {
    throw new Error('Method destroyWebhookStream() is not supported by this provider');
  }
}
