import { ethers } from 'ethers';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { RateLimiter } from './rate-limiter';

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
  private isWebSocketConnected = false;
  private rateLimiter: RateLimiter;

  constructor(options: EtherJSProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this._httpClient = new ethers.JsonRpcProvider(this.httpUrl);
    this.wsUrl = options.wsUrl;
    this.network = options.network;

    // Initialize rate limiter with user config
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  get connectionOptions() {
    return {
      type: this.type,
      uniqName: this.uniqName,
      httpUrl: this.httpUrl,
      wsUrl: this.wsUrl,
      network: this.network,
      rateLimits: this.rateLimiter.getStats().config,
    };
  }

  get wsClient() {
    return this._wsClient;
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this.rateLimiter.executeRequest(() => this._httpClient.getBlockNumber());
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Checks if WebSocket connection is healthy
   */
  public async healthcheckWebSocket(): Promise<boolean> {
    if (!this._wsClient || !this.isWebSocketConnected) {
      return false;
    }

    try {
      // Check if WebSocket is still connected
      if (this._wsClient.websocket?.readyState !== this._wsClient.websocket?.OPEN) {
        this.isWebSocketConnected = false;
        return false;
      }

      // Try a simple operation to verify connection
      await this._wsClient.getBlockNumber();
      return true;
    } catch (error) {
      this.isWebSocketConnected = false;
      return false;
    }
  }

  public async connect(): Promise<void> {
    const health = await this.healthcheck();
    if (!health) {
      throw new Error('Cannot connect to the node');
    }

    if (this.wsUrl) {
      await this.connectWebSocket();
    }
  }

  public async disconnect(): Promise<void> {
    this.isWebSocketConnected = false;

    if (this._wsClient) {
      try {
        this._wsClient.destroy();
      } catch (error) {
        // Ignore destruction errors
      }
      this._wsClient = undefined;
    }
  }

  /**
   * Reconnects WebSocket connection
   * This method is called by ConnectionManager when WebSocket health check fails
   */
  public async reconnectWebSocket(): Promise<void> {
    // Disconnect existing WebSocket first
    if (this._wsClient) {
      try {
        this._wsClient.destroy();
      } catch (error) {
        // Ignore destruction errors
      }
      this._wsClient = undefined;
      this.isWebSocketConnected = false;
    }

    // Establish new WebSocket connection
    if (this.wsUrl) {
      await this.connectWebSocket();
    }
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.wsUrl) {
      throw new Error('WebSocket URL not provided');
    }

    return new Promise<void>((resolve, reject) => {
      try {
        this._wsClient = new ethers.WebSocketProvider(this.wsUrl!, this.network);

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        const handleOpen = () => {
          this.isWebSocketConnected = true;
          clearTimeout(timeout);
          cleanup();
          resolve();
        };

        const handleError = (error: any) => {
          this.isWebSocketConnected = false;
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`WebSocket connection error: ${error.message || error}`));
        };

        const handleClose = () => {
          this.isWebSocketConnected = false;
          // Don't reject here - ConnectionManager will handle reconnection
        };

        const cleanup = () => {
          if (this._wsClient?.websocket) {
            this._wsClient.websocket.removeListener('open', handleOpen);
            this._wsClient.websocket.removeListener('error', handleError);
            this._wsClient.websocket.removeListener('close', handleClose);
          }
        };

        // Check if websocket is already open
        if (this._wsClient.websocket?.readyState === this._wsClient.websocket?.OPEN) {
          this.isWebSocketConnected = true;
          clearTimeout(timeout);
          resolve();
          return;
        }

        // Set up event listeners
        if (this._wsClient.websocket) {
          this._wsClient.websocket.on('open', handleOpen);
          this._wsClient.websocket.on('error', handleError);
          this._wsClient.websocket.on('close', handleClose);
        } else {
          // If websocket is not immediately available, wait a bit and check again
          setTimeout(() => {
            if (this._wsClient?.websocket) {
              this._wsClient.websocket.on('open', handleOpen);
              this._wsClient.websocket.on('error', handleError);
              this._wsClient.websocket.on('close', handleClose);
            } else {
              clearTimeout(timeout);
              reject(new Error('WebSocket not available'));
            }
          }, 100);
        }
      } catch (error) {
        this.isWebSocketConnected = false;
        reject(error);
      }
    });
  }

  public async getBlockHeight(): Promise<number> {
    return await this.rateLimiter.executeRequest(() => this._httpClient.getBlockNumber());
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<any> {
    return await this.rateLimiter.executeRequest(() => this._httpClient.getBlock(blockNumber, fullTransactions));
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<any> {
    return await this.rateLimiter.executeRequest(() => this._httpClient.getBlock(hash, fullTransactions));
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<any[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.getBlock(hash, fullTransactions));

    return await this.rateLimiter.executeBatchRequests(requestFns);
  }

  public async getManyHashesByHeights(heights: number[]): Promise<string[]> {
    const requestFns = heights.map((height) => () => this._httpClient.getBlock(height));

    const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
    return blocks.map((block: any) => block.hash);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<any[]> {
    const requestFns = heights.map((height) => () => this._httpClient.getBlock(height, fullTransactions));

    return await this.rateLimiter.executeBatchRequests(requestFns);
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    if (hasGenesis) {
      // Get statistics for the genesis block (in Ethereum, this is block 0)
      const genesisBlock = (await this.rateLimiter.executeRequest(() =>
        this._httpClient.getBlock(genesisHeight, false)
      )) as any;
      const genesisStats = {
        number: genesisBlock.number,
        hash: genesisBlock.hash,
        size: genesisBlock.size ? parseInt(genesisBlock.size, 16) : 0,
      };

      // Process the remaining blocks, excluding genesis
      const filteredHeights = heights.filter((height) => height !== genesisHeight);
      const requestFns = filteredHeights.map((height) => () => this._httpClient.getBlock(height, false));

      const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
      const stats = blocks.map((block: any) => ({
        number: block.number,
        hash: block.hash,
        size: block.size ? parseInt(block.size, 16) : 0,
      }));

      return [genesisStats, ...stats.filter((block: any) => block)];
    } else {
      // Process all blocks equally
      const requestFns = heights.map((height) => () => this._httpClient.getBlock(height, false));

      const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
      return blocks
        .map((block: any) => ({
          number: block.number,
          hash: block.hash,
          size: block.size ? parseInt(block.size, 16) : 0,
        }))
        .filter((block: any) => block);
    }
  }

  /**
   * Get rate limiter statistics
   */
  public getRateLimiterStats() {
    return this.rateLimiter.getStats();
  }
}
