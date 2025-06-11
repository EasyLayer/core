import { ethers } from 'ethers';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { RateLimiter } from './rate-limiter';
import type { UniversalBlock, UniversalTransaction, UniversalTransactionReceipt, NetworkConfig } from './interfaces';

export interface EtherJSProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  network: NetworkConfig;
}

export const createEtherJSProvider = (options: EtherJSProviderOptions): EtherJSProvider => {
  return new EtherJSProvider(options);
};

export class EtherJSProvider extends BaseNodeProvider<EtherJSProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.ETHERJS;
  private httpUrl: string;
  private wsUrl?: string;
  private network: NetworkConfig;
  private isWebSocketConnected = false;
  private rateLimiter: RateLimiter;

  constructor(options: EtherJSProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this._httpClient = new ethers.JsonRpcProvider(this.httpUrl);
    this.wsUrl = options.wsUrl;
    this.network = options.network;

    // Initialize rate limiter with network config
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
        // Use chainId from networkConfig for better compatibility
        // Priority: explicit network name > chainId > auto-detect (undefined)
        const networkIdentifier = this.network.chainId;
        this._wsClient = new ethers.WebSocketProvider(this.wsUrl!, networkIdentifier);

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

  // ===== BLOCK METHODS =====

  public async getBlockHeight(): Promise<number> {
    return await this.rateLimiter.executeRequest(() => this._httpClient.getBlockNumber());
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const ethersBlock = await this.rateLimiter.executeRequest(() =>
      this._httpClient.getBlock(blockNumber, fullTransactions)
    );

    if (!ethersBlock) {
      throw new Error(`Block ${blockNumber} not found`);
    }

    return this.normalizeBlock(ethersBlock);
  }

  public async getOneBlockHashByHeight(height: number): Promise<string> {
    const block = await this.rateLimiter.executeRequest<UniversalBlock>(() => this._httpClient.getBlock(height, false));

    if (!block) {
      throw new Error(`Block ${height} not found`);
    }

    return block.hash;
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const ethersBlock = await this.rateLimiter.executeRequest(() => this._httpClient.getBlock(hash, fullTransactions));

    if (!ethersBlock) {
      throw new Error(`Block ${hash} not found`);
    }

    return this.normalizeBlock(ethersBlock);
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.getBlock(hash, fullTransactions));

    const ethersBlocks = await this.rateLimiter.executeBatchRequests(requestFns);

    return ethersBlocks.filter((block) => block !== null).map((block) => this.normalizeBlock(block));
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    const requestFns = heights.map((height) => () => this._httpClient.getBlock(height, fullTransactions));

    const ethersBlocks = await this.rateLimiter.executeBatchRequests(requestFns);

    return ethersBlocks.filter((block) => block !== null).map((block) => this.normalizeBlock(block));
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    if (hasGenesis) {
      // Get statistics for the genesis block (in Ethereum, this is block 0)
      const genesisBlock = await this.rateLimiter.executeRequest<UniversalBlock>(() =>
        this._httpClient.getBlock(genesisHeight, false)
      );

      const genesisStats = {
        number: genesisBlock.number,
        hash: genesisBlock.hash,
        size: genesisBlock.size || 0,
      };

      // Process the remaining blocks, excluding genesis
      const filteredHeights = heights.filter((height) => height !== genesisHeight);
      const requestFns = filteredHeights.map((height) => () => this._httpClient.getBlock(height, false));

      const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
      const stats = blocks
        .filter((block) => block !== null)
        .map((block: any) => ({
          number: block.number,
          hash: block.hash,
          size: block.size || 0,
        }));

      return [genesisStats, ...stats];
    } else {
      // Process all blocks equally
      const requestFns = heights.map((height) => () => this._httpClient.getBlock(height, false));

      const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
      return blocks
        .filter((block) => block !== null)
        .map((block: any) => ({
          number: block.number,
          hash: block.hash,
          size: block.size || 0,
        }));
    }
  }

  // ===== TRANSACTION METHODS =====

  public async getOneTransactionByHash(hash: Hash): Promise<UniversalTransaction> {
    const ethersTx = await this.rateLimiter.executeRequest(() => this._httpClient.getTransaction(hash));

    if (!ethersTx) {
      throw new Error(`Transaction ${hash} not found`);
    }

    return this.normalizeTransaction(ethersTx);
  }

  public async getManyTransactionsByHashes(hashes: Hash[]): Promise<UniversalTransaction[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.getTransaction(hash));

    const ethersTransactions = await this.rateLimiter.executeBatchRequests(requestFns);

    return ethersTransactions.filter((tx) => tx !== null).map((tx) => this.normalizeTransaction(tx));
  }

  public async getTransactionReceipt(hash: Hash): Promise<UniversalTransactionReceipt> {
    const ethersReceipt = await this.rateLimiter.executeRequest(() => this._httpClient.getTransactionReceipt(hash));

    if (!ethersReceipt) {
      throw new Error(`Transaction receipt ${hash} not found`);
    }

    // Normalize ethers receipt to UniversalTransactionReceipt
    return this.normalizeReceipt(ethersReceipt);
  }

  public async getManyTransactionReceipts(hashes: Hash[]): Promise<UniversalTransactionReceipt[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.getTransactionReceipt(hash));

    const ethersReceipts = await this.rateLimiter.executeBatchRequests(requestFns);

    return ethersReceipts.filter((receipt) => receipt !== null).map((receipt) => this.normalizeReceipt(receipt));
  }

  /**
   * Normalizes ethers.js Block object to UniversalBlock format
   * Handles BigInt values and ethers-specific field naming
   */
  private normalizeBlock(ethersBlock: any): UniversalBlock {
    return {
      hash: ethersBlock.hash,
      parentHash: ethersBlock.parentHash,
      blockNumber: ethersBlock.number,
      nonce: ethersBlock.nonce,
      sha3Uncles: ethersBlock.sha3Uncles,
      logsBloom: ethersBlock.logsBloom,
      transactionsRoot: ethersBlock.transactionsRoot,
      stateRoot: ethersBlock.stateRoot,
      receiptsRoot: ethersBlock.receiptsRoot,
      miner: ethersBlock.miner,

      // Convert BigInt to string for difficulty values
      difficulty: ethersBlock.difficulty?.toString() || '0',
      totalDifficulty: ethersBlock.totalDifficulty?.toString() || '0',

      extraData: ethersBlock.extraData,
      size: ethersBlock.size || 0,

      // Convert BigInt to number for gas values
      gasLimit: Number(ethersBlock.gasLimit) || 0,
      gasUsed: Number(ethersBlock.gasUsed) || 0,

      timestamp: ethersBlock.timestamp || 0,
      uncles: ethersBlock.uncles || [],

      // EIP-1559 fields - convert BigInt to string
      baseFeePerGas: ethersBlock.baseFeePerGas?.toString(),

      // Shanghai fork fields
      withdrawals: ethersBlock.withdrawals,
      withdrawalsRoot: ethersBlock.withdrawalsRoot,

      // Cancun fork fields - convert BigInt to string
      blobGasUsed: ethersBlock.blobGasUsed?.toString(),
      excessBlobGas: ethersBlock.excessBlobGas?.toString(),
      parentBeaconBlockRoot: ethersBlock.parentBeaconBlockRoot,

      // Normalize transactions if present
      transactions: ethersBlock.transactions?.map((tx: any) => this.normalizeTransaction(tx)),
    };
  }

  /**
   * Normalizes ethers.js TransactionResponse to UniversalTransaction format
   * Handles BigInt values, signature extraction, and field mapping
   */
  private normalizeTransaction(ethersTx: any): UniversalTransaction {
    return {
      hash: ethersTx.hash,
      nonce: ethersTx.nonce || 0,
      from: ethersTx.from,
      to: ethersTx.to,

      // Convert BigInt value to string
      value: ethersTx.value?.toString() || '0',

      // Convert BigInt gasLimit to number for gas field
      gas: Number(ethersTx.gasLimit) || 0,

      input: ethersTx.data || ethersTx.input || '0x',
      blockHash: ethersTx.blockHash,
      blockNumber: ethersTx.blockNumber,

      // Handle both transactionIndex and index fields
      transactionIndex: ethersTx.transactionIndex ?? ethersTx.index,

      // Convert BigInt gasPrice to string
      gasPrice: ethersTx.gasPrice?.toString(),

      // Convert BigInt chainId to number
      chainId: ethersTx.chainId ? Number(ethersTx.chainId) : undefined,

      // Extract signature fields from signature object or direct fields
      v: ethersTx.signature?.v?.toString() || ethersTx.v?.toString(),
      r: ethersTx.signature?.r || ethersTx.r,
      s: ethersTx.signature?.s || ethersTx.s,

      // Convert transaction type to string
      type: ethersTx.type?.toString() || '0',

      // EIP-1559 fields - convert BigInt to string
      maxFeePerGas: ethersTx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: ethersTx.maxPriorityFeePerGas?.toString(),

      // EIP-2930 access list
      accessList: ethersTx.accessList,

      // EIP-4844 blob transaction fields - convert BigInt to string
      maxFeePerBlobGas: ethersTx.maxFeePerBlobGas?.toString(),
      blobVersionedHashes: ethersTx.blobVersionedHashes,
    };
  }

  /**
   * Normalizes ethers.js transaction receipt to UniversalTransactionReceipt
   */
  private normalizeReceipt(ethersReceipt: any): UniversalTransactionReceipt {
    return {
      transactionHash: ethersReceipt.hash || ethersReceipt.transactionHash,
      transactionIndex: ethersReceipt.transactionIndex ?? ethersReceipt.index,
      blockHash: ethersReceipt.blockHash,
      blockNumber: ethersReceipt.blockNumber,
      from: ethersReceipt.from,
      to: ethersReceipt.to,

      // Convert BigInt values to numbers
      cumulativeGasUsed: Number(ethersReceipt.cumulativeGasUsed),
      gasUsed: Number(ethersReceipt.gasUsed),

      contractAddress: ethersReceipt.contractAddress,
      logs:
        ethersReceipt.logs?.map((log: any) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          transactionIndex: log.transactionIndex,
          blockHash: log.blockHash,
          logIndex: log.logIndex ?? log.index,
          removed: log.removed || false,
        })) || [],
      logsBloom: ethersReceipt.logsBloom,
      status: ethersReceipt.status === 1 ? '0x1' : '0x0',
      type: ethersReceipt.type?.toString() || '0x0',

      // Convert BigInt effectiveGasPrice to number
      effectiveGasPrice: Number(ethersReceipt.effectiveGasPrice || 0),

      // Convert BigInt blob fields to strings
      blobGasUsed: ethersReceipt.blobGasUsed?.toString(),
      blobGasPrice: ethersReceipt.blobGasPrice?.toString(),
    };
  }
}
