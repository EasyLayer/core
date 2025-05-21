import * as Web3Module from 'web3';
const Web3 = (Web3Module as any).default ?? Web3Module;
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';

export interface Web3jsProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  network?: string;
}

export const createWeb3jsProvider = (options: Web3jsProviderOptions): Web3jsProvider => {
  return new Web3jsProvider(options);
};

export class Web3jsProvider extends BaseNodeProvider<Web3jsProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.WEB3JS;
  private httpUrl: string;
  private wsUrl?: string;
  private network?: string;

  constructor(options: Web3jsProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this._httpClient = new Web3(new Web3.providers.HttpProvider(this.httpUrl));

    if (options.wsUrl) {
      this.wsUrl = options.wsUrl;

      const wsProviderOptions: any = {
        reconnect: {
          auto: true,
          delay: 1000,
          maxAttempts: 10,
        },
      };
      const wsProvider = new Web3.providers.WebsocketProvider(this.wsUrl, wsProviderOptions);
      this._wsClient = new Web3(wsProvider);
    }

    this.network = options.network;
  }

  get connectionOptions() {
    return {
      type: this.type,
      uniqName: this.uniqName,
      httpUrl: this.httpUrl,
      wsUrl: this.wsUrl,
      network: this.network,
    };
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this._httpClient.eth.getBlockNumber();
      return true;
    } catch (error) {
      return false;
    }
  }

  public async connect(): Promise<void> {
    const healthy = await this.healthcheck();
    if (!healthy) {
      throw new Error('Cannot connect to the Web3js node');
    }

    await new Promise<void>((resolve, reject) => {
      const provider = this._wsClient?.currentProvider;
      if (!provider) {
        return reject(new Error('WebSocket provider is undefined'));
      }

      provider.on('connect', () => resolve());
      provider.on('error', (err: any) => reject(err));
    });
  }

  public async disconnect(): Promise<void> {
    if (this._wsClient) {
      const provider = this._wsClient.currentProvider;
      if (provider && typeof provider.disconnect === 'function') {
        provider.disconnect(1000, 'Client disconnecting');
      }
    }
  }

  public async getBlockHeight(): Promise<number> {
    const blockNumber = await this._httpClient.eth.getBlockNumber();
    return Number(blockNumber);
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<any> {
    return await this._httpClient.eth.getBlock(blockNumber, fullTransactions);
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<any> {
    return await this._httpClient.eth.getBlock(hash, fullTransactions);
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<any[]> {
    const promises = hashes.map((hash) => this._httpClient.eth.getBlock(hash, fullTransactions));
    return await Promise.all(promises);
  }

  public async getManyHashesByHeights(heights: number[]): Promise<string[]> {
    const promises = heights.map((height) => this._httpClient.eth.getBlock(height));
    const blocks = await Promise.all(promises);
    return blocks.map((block) => block.hash).filter((hash): hash is string => !!hash);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<any[]> {
    const promises = heights.map((height) => this._httpClient.eth.getBlock(height, fullTransactions));
    return await Promise.all(promises);
  }
}
