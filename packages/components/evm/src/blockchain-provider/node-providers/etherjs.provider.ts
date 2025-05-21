import { ethers } from 'ethers';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';

export interface EtherJSProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  network?: string;
}

export const createEtherJSProvider = (options: EtherJSProviderOptions): EtherJSProvider => {
  return new EtherJSProvider(options);
};

export class EtherJSProvider extends BaseNodeProvider<EtherJSProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.ETHERJS;
  private httpUrl: string;
  private wsUrl?: string;
  private network?: string;

  constructor(options: EtherJSProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this._httpClient = new ethers.JsonRpcProvider(this.httpUrl);
    this.wsUrl = options.wsUrl;
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
      await this._httpClient.getBlockNumber();
      return true;
    } catch (error) {
      return false;
    }
  }

  public async connect(): Promise<void> {
    const health = await this.healthcheck();
    if (!health) {
      throw new Error('Cannot connect to the node');
    }

    if (this.wsUrl) {
      this._wsClient = new ethers.WebSocketProvider(this.wsUrl, this.network);

      // if (this._wsClient?.websocket?.readyState === this._wsClient?.websocket?.OPEN) {
      //   return;
      // }

      // await new Promise<void>((resolve, reject) => {
      //   const timeout = setTimeout(() => {
      //     cleanup();
      //     reject(new Error('WebSocket connection timeout'));
      //   }, 10000);

      //   const handleOpen = () => {
      //     clearTimeout(timeout);
      //     cleanup();
      //     resolve();
      //   };

      //   const handleError = (err: any) => {
      //     clearTimeout(timeout);
      //     cleanup();
      //     reject(err);
      //   };

      //   const cleanup = () => {
      //     if (this._wsClient && this._wsClient.websocket) {
      //       this._wsClient.websocket.removeListener('open', handleOpen);
      //       this._wsClient.websocket.removeListener('error', handleError);
      //     }
      //   };

      //   this._wsClient.websocket.on('open', handleOpen);
      //   this._wsClient.websocket.on('error', handleError);
      // });
    }
  }

  public async disconnect(): Promise<void> {
    if (this._wsClient) {
      this._wsClient.destroy();
    }
  }

  public async getBlockHeight(): Promise<number> {
    return await this._httpClient.getBlockNumber();
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<any> {
    return await this._httpClient.getBlock(blockNumber, fullTransactions);
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<any> {
    return await this._httpClient.getBlock(hash, fullTransactions);
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<any[]> {
    const promises = hashes.map((hash) => this._httpClient.getBlock(hash, fullTransactions));
    return await Promise.all(promises);
  }

  public async getManyHashesByHeights(heights: number[]): Promise<string[]> {
    const promises = heights.map((height) => this._httpClient.getBlock(height));
    const blocks = await Promise.all(promises);
    return blocks.map((block: any) => block.hash);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<any[]> {
    const promises = heights.map((height) => this._httpClient.getBlock(height, fullTransactions));
    return await Promise.all(promises);
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    if (hasGenesis) {
      // Get statistics for the genesis block (in Ethereum, this is block 0)
      // If the node returns a valid size field for it, it will be used,
      // otherwise you can set size to 0.
      const genesisBlock = await this._httpClient.getBlock(genesisHeight, false);
      const genesisStats = {
        number: genesisBlock.number,
        hash: genesisBlock.hash,
        size: genesisBlock.size ? parseInt(genesisBlock.size, 16) : 0,
      };

      // We process the remaining blocks, excluding genesis
      const filteredHeights = heights.filter((height) => height !== genesisHeight);
      const promises = filteredHeights.map((height) => this._httpClient.getBlock(height, false));
      const blocks = await Promise.all(promises);

      const stats = blocks.map((block: any) => ({
        number: block.number,
        hash: block.hash,
        size: block.size ? parseInt(block.size, 16) : 0,
      }));

      return [genesisStats, ...stats.filter((block: any) => block)];
    } else {
      // If the genesis block is not included in the requested heights, we process all blocks equally
      const promises = heights.map((height) => this._httpClient.getBlock(height, false));
      const blocks = await Promise.all(promises);

      return blocks
        .map((block: any) => ({
          number: block.number,
          hash: block.hash,
          size: block.size ? parseInt(block.size, 16) : 0,
        }))
        .filter((block: any) => block);
    }
  }
}
