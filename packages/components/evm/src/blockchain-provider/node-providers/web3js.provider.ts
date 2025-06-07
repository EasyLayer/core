import * as Web3Module from 'web3';
const Web3 = (Web3Module as any).default ?? Web3Module;
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { RateLimiter } from './rate-limiter';

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
  private isWebSocketConnected = false;
  private rateLimiter: RateLimiter;

  constructor(options: Web3jsProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this._httpClient = new Web3(new Web3.providers.HttpProvider(this.httpUrl));
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
      await this.rateLimiter.executeRequest(() => this._httpClient.eth.getBlockNumber());
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
      // Simple check - try to get block number via WebSocket
      await this._wsClient.eth.getBlockNumber();
      return true;
    } catch (error) {
      this.isWebSocketConnected = false;
      return false;
    }
  }

  public async connect(): Promise<void> {
    const healthy = await this.healthcheck();
    if (!healthy) {
      throw new Error('Cannot connect to the Web3js node');
    }

    // Connect WebSocket if URL is provided
    if (this.wsUrl) {
      await this.connectWebSocket();
    }
  }

  public async disconnect(): Promise<void> {
    this.isWebSocketConnected = false;

    if (this._wsClient) {
      const provider = this._wsClient.currentProvider;
      if (provider && typeof provider.disconnect === 'function') {
        try {
          provider.disconnect(1000, 'Client disconnecting');
        } catch (error) {
          // Ignore disconnection errors
        }
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
      const provider = this._wsClient.currentProvider;
      if (provider && typeof provider.disconnect === 'function') {
        try {
          provider.disconnect(1000, 'Reconnecting');
        } catch (error) {
          // Ignore disconnection errors
        }
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
      const wsProviderOptions: any = {
        reconnect: {
          auto: false, // ConnectionManager handles reconnection
          delay: 1000,
          maxAttempts: 1,
        },
      };

      const wsProvider = new Web3.providers.WebsocketProvider(this.wsUrl!, wsProviderOptions);
      this._wsClient = new Web3(wsProvider);

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
        wsProvider.removeListener('connect', handleOpen);
        wsProvider.removeListener('error', handleError);
        wsProvider.removeListener('close', handleClose);
        wsProvider.removeListener('end', handleClose);
      };

      wsProvider.on('connect', handleOpen);
      wsProvider.on('error', handleError);
      wsProvider.on('close', handleClose);
      wsProvider.on('end', handleClose);
    });
  }

  public async getBlockHeight(): Promise<number> {
    const blockNumber = await this.rateLimiter.executeRequest(() => this._httpClient.eth.getBlockNumber());
    return Number(blockNumber);
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<any> {
    return await this.rateLimiter.executeRequest(() => this._httpClient.eth.getBlock(blockNumber, fullTransactions));
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<any> {
    return await this.rateLimiter.executeRequest(() => this._httpClient.eth.getBlock(hash, fullTransactions));
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<any[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.eth.getBlock(hash, fullTransactions));

    return await this.rateLimiter.executeBatchRequests(requestFns);
  }

  public async getManyHashesByHeights(heights: number[]): Promise<string[]> {
    const requestFns = heights.map((height) => () => this._httpClient.eth.getBlock(height));

    const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
    return blocks.map((block: any) => block.hash).filter((hash): hash is string => !!hash);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<any[]> {
    const requestFns = heights.map((height) => () => this._httpClient.eth.getBlock(height, fullTransactions));

    return await this.rateLimiter.executeBatchRequests(requestFns);
  }

  /**
   * Get rate limiter statistics
   */
  public getRateLimiterStats() {
    return this.rateLimiter.getStats();
  }
}
