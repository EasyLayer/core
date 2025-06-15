import * as Web3Module from 'web3';
const Web3 = (Web3Module as any).default ?? Web3Module;
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { RateLimiter } from './rate-limiter';
import type { UniversalBlock, UniversalTransaction, UniversalTransactionReceipt, NetworkConfig } from './interfaces';

export interface Web3jsProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  network: NetworkConfig;
}

export const createWeb3jsProvider = (options: Web3jsProviderOptions): Web3jsProvider => {
  return new Web3jsProvider(options);
};

export class Web3jsProvider extends BaseNodeProvider<Web3jsProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.WEB3JS;
  private httpUrl: string;
  private wsUrl?: string;
  private isWebSocketConnected = false;
  private network: NetworkConfig;
  private rateLimiter: RateLimiter;

  constructor(options: Web3jsProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this._httpClient = new Web3(new Web3.providers.HttpProvider(this.httpUrl));
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
      await this.rateLimiter.executeRequest(() => this.getActiveWeb3().eth.getBlockNumber());
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Gets the active Web3 instance - WebSocket if available, otherwise HTTP
   */
  private getActiveWeb3(): any {
    if (this.isWebSocketConnected && this._wsClient) {
      return this._wsClient;
    }
    return this._httpClient;
  }

  /**
   * Executes a request with automatic WebSocket/HTTP fallback
   */
  private async executeWithFallback<T>(operation: (web3: any) => Promise<T>): Promise<T> {
    // Try WebSocket first if available
    if (this.isWebSocketConnected && this._wsClient) {
      try {
        return await operation(this._wsClient);
      } catch (error) {
        // Mark WebSocket as disconnected and fallback to HTTP
        this.isWebSocketConnected = false;
      }
    }

    // Fallback to HTTP
    return await operation(this._httpClient);
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

      const handleOpen = async () => {
        try {
          // Validate chainId after connection (Web3.js doesn't do this automatically)
          const connectedChainId = await this._wsClient.eth.getChainId();
          const expectedChainId = this.network.chainId;

          if (Number(connectedChainId) !== expectedChainId) {
            this.isWebSocketConnected = false;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${connectedChainId}`));
            return;
          }

          this.isWebSocketConnected = true;
          clearTimeout(timeout);
          cleanup();
          resolve();
        } catch (error) {
          this.isWebSocketConnected = false;
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`WebSocket validation error: ${error}`));
        }
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

  // ===== BLOCK METHODS =====

  public async getBlockHeight(): Promise<number> {
    const blockNumber = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((web3) => web3.eth.getBlockNumber())
    );
    return Number(blockNumber);
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const web3Block = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((web3) => web3.eth.getBlock(blockNumber, fullTransactions))
    );

    if (!web3Block) {
      throw new Error(`Block ${blockNumber} not found`);
    }

    return this.normalizeBlock(web3Block);
  }

  public async getOneBlockHashByHeight(height: number): Promise<string> {
    const block = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback<any>((web3) => web3.eth.getBlock(height, false))
    );

    if (!block) {
      throw new Error(`Block ${height} not found`);
    }

    return block.hash;
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const web3Block = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((web3) => web3.eth.getBlock(hash, fullTransactions))
    );

    if (!web3Block) {
      throw new Error(`Block ${hash} not found`);
    }

    return this.normalizeBlock(web3Block);
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    if (hashes.length === 0) {
      return [];
    }

    // Web3.js doesn't support native batch requests, use sequential execution
    const requestFns = hashes.map(
      (hash) => () => this.executeWithFallback((web3) => web3.eth.getBlock(hash, fullTransactions))
    );

    const web3Blocks = await this.rateLimiter.executeSequentialRequests(requestFns);

    return web3Blocks.filter((block) => block !== null).map((block) => this.normalizeBlock(block));
  }

  public async getManyHashesByHeights(heights: number[]): Promise<string[]> {
    if (heights.length === 0) {
      return [];
    }

    // Web3.js doesn't support native batch requests, use sequential execution
    const requestFns = heights.map((height) => () => this.executeWithFallback((web3) => web3.eth.getBlock(height)));

    const blocks = await this.rateLimiter.executeSequentialRequests(requestFns);
    return blocks.map((block: any) => block.hash).filter((hash): hash is string => !!hash);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    if (heights.length === 0) {
      return [];
    }

    // Web3.js doesn't support native batch requests, use sequential execution
    const requestFns = heights.map(
      (height) => () => this.executeWithFallback((web3) => web3.eth.getBlock(height, fullTransactions))
    );

    const web3Blocks = await this.rateLimiter.executeSequentialRequests(requestFns);

    return web3Blocks.filter((block) => block !== null).map((block) => this.normalizeBlock(block));
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    if (heights.length === 0) {
      return [];
    }

    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    if (hasGenesis) {
      // Get statistics for the genesis block
      const genesisBlock = await this.rateLimiter.executeRequest(() =>
        this.executeWithFallback<any>((web3) => web3.eth.getBlock(genesisHeight, false))
      );

      const genesisStats = {
        number: Number(genesisBlock.blockNumber || genesisBlock.number),
        hash: genesisBlock.hash,
        size: Number(genesisBlock.size) || 0,
      };

      // Process the remaining blocks, excluding genesis
      const filteredHeights = heights.filter((height) => height !== genesisHeight);

      if (filteredHeights.length === 0) {
        return [genesisStats];
      }

      const requestFns = filteredHeights.map(
        (height) => () => this.executeWithFallback<any>((web3) => web3.eth.getBlock(height, false))
      );

      const blocks = await this.rateLimiter.executeSequentialRequests(requestFns);
      const stats = blocks
        .filter((block) => block !== null)
        .map((block: any) => ({
          number: Number(block.number),
          hash: block.hash,
          size: Number(block.size) || 0,
        }));

      return [genesisStats, ...stats];
    } else {
      // Process all blocks equally
      const requestFns = heights.map(
        (height) => () => this.executeWithFallback<any>((web3) => web3.eth.getBlock(height, false))
      );

      const blocks = await this.rateLimiter.executeSequentialRequests(requestFns);
      return blocks
        .filter((block) => block !== null)
        .map((block: any) => ({
          number: Number(block.number),
          hash: block.hash,
          size: Number(block.size) || 0,
        }));
    }
  }

  // ===== TRANSACTION METHODS =====

  public async getOneTransactionByHash(hash: Hash): Promise<UniversalTransaction> {
    const web3Tx = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((web3) => web3.eth.getTransaction(hash))
    );

    if (!web3Tx) {
      throw new Error(`Transaction ${hash} not found`);
    }

    return this.normalizeTransaction(web3Tx);
  }

  public async getManyTransactionsByHashes(hashes: Hash[]): Promise<UniversalTransaction[]> {
    if (hashes.length === 0) {
      return [];
    }

    // Web3.js doesn't support native batch requests, use sequential execution
    const requestFns = hashes.map((hash) => () => this.executeWithFallback((web3) => web3.eth.getTransaction(hash)));

    const web3Transactions = await this.rateLimiter.executeSequentialRequests(requestFns);

    return web3Transactions.filter((tx) => tx !== null).map((tx) => this.normalizeTransaction(tx));
  }

  public async getTransactionReceipt(hash: Hash): Promise<UniversalTransactionReceipt> {
    const web3Receipt = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((web3) => web3.eth.getTransactionReceipt(hash))
    );

    if (!web3Receipt) {
      throw new Error(`Transaction receipt ${hash} not found`);
    }

    // Normalize web3 receipt to UniversalTransactionReceipt
    return this.normalizeReceipt(web3Receipt);
  }

  public async getManyTransactionReceipts(hashes: Hash[]): Promise<UniversalTransactionReceipt[]> {
    if (hashes.length === 0) {
      return [];
    }

    // Web3.js doesn't support native batch requests, use sequential execution
    const requestFns = hashes.map(
      (hash) => () => this.executeWithFallback((web3) => web3.eth.getTransactionReceipt(hash))
    );

    const web3Receipts = await this.rateLimiter.executeSequentialRequests(requestFns);

    return web3Receipts.filter((receipt) => receipt !== null).map((receipt) => this.normalizeReceipt(receipt));
  }

  /**
   * Normalizes web3.js v4 transaction receipt to UniversalTransactionReceipt
   * Handles BigInt values that Web3.js v4 returns
   */
  normalizeReceipt(web3Receipt: any): UniversalTransactionReceipt {
    return {
      transactionHash: web3Receipt.transactionHash,
      // Convert BigInt transactionIndex to number
      transactionIndex: Number(web3Receipt.transactionIndex),
      blockHash: web3Receipt.blockHash,
      // Convert BigInt blockNumber to number
      blockNumber: Number(web3Receipt.blockNumber),
      from: web3Receipt.from,
      to: web3Receipt.to,
      // Convert BigInt gas values to numbers
      cumulativeGasUsed: Number(web3Receipt.cumulativeGasUsed),
      gasUsed: Number(web3Receipt.gasUsed),
      contractAddress: web3Receipt.contractAddress,
      logs:
        web3Receipt.logs?.map((log: any) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          // Convert BigInt blockNumber to number
          blockNumber: Number(log.blockNumber),
          transactionHash: log.transactionHash,
          // Convert BigInt transactionIndex to number
          transactionIndex: Number(log.transactionIndex),
          blockHash: log.blockHash,
          // Convert BigInt logIndex to number
          logIndex: Number(log.logIndex),
          removed: log.removed || false,
        })) || [],
      logsBloom: web3Receipt.logsBloom,
      status: web3Receipt.status ? '0x1' : '0x0',
      // Convert BigInt type to string
      type: web3Receipt.type?.toString() || '0x0',
      // Convert BigInt effectiveGasPrice to number
      effectiveGasPrice: Number(web3Receipt.effectiveGasPrice || 0),
      // Convert BigInt blob fields to strings
      blobGasUsed: web3Receipt.blobGasUsed?.toString(),
      blobGasPrice: web3Receipt.blobGasPrice?.toString(),
    };
  }

  /**
   * Normalizes web3.js v4 block object to UniversalBlock format
   * Handles BigInt values and web3.js v4 specific field types
   */
  normalizeBlock(web3Block: any): UniversalBlock {
    return {
      hash: web3Block.hash,
      parentHash: web3Block.parentHash,
      // Priority: blockNumber field first, then number field
      blockNumber: Number(web3Block.blockNumber || web3Block.number),
      nonce: web3Block.nonce,
      sha3Uncles: web3Block.sha3Uncles,
      logsBloom: web3Block.logsBloom,
      transactionsRoot: web3Block.transactionsRoot,
      stateRoot: web3Block.stateRoot,
      receiptsRoot: web3Block.receiptsRoot,
      miner: web3Block.miner,
      // Convert BigInt to string for large numbers
      difficulty: web3Block.difficulty?.toString() || '0',
      totalDifficulty: web3Block.totalDifficulty?.toString() || '0',
      extraData: web3Block.extraData,
      // Convert BigInt size to number
      size: Number(web3Block.size) || 0,
      // Convert BigInt gas values to numbers
      gasLimit: Number(web3Block.gasLimit) || 0,
      gasUsed: Number(web3Block.gasUsed) || 0,
      // Convert BigInt timestamp to number
      timestamp: Number(web3Block.timestamp) || 0,
      uncles: web3Block.uncles || [],
      // EIP-1559 fields - convert BigInt to string
      baseFeePerGas: web3Block.baseFeePerGas?.toString(),
      // Shanghai fork fields
      withdrawals: web3Block.withdrawals,
      withdrawalsRoot: web3Block.withdrawalsRoot,
      // Cancun fork fields - convert BigInt to string
      blobGasUsed: web3Block.blobGasUsed?.toString(),
      excessBlobGas: web3Block.excessBlobGas?.toString(),
      parentBeaconBlockRoot: web3Block.parentBeaconBlockRoot,
      // Normalize transactions if present
      // In Web3.js v4, when hydrated=true, transactions are full objects
      // When hydrated=false, transactions are string hashes
      transactions: web3Block.transactions?.map((tx: any) => {
        // If transaction is a string (hash), return as is
        if (typeof tx === 'string') {
          return tx;
        }
        // If transaction is an object, normalize it
        return this.normalizeTransaction(tx);
      }),
    };
  }

  /**
   * Normalizes web3.js v4 transaction object to UniversalTransaction format
   * Handles BigInt values that Web3.js v4 returns and ensures proper data conversion
   */
  normalizeTransaction(web3Tx: any): UniversalTransaction {
    return {
      hash: web3Tx.hash,
      // Convert BigInt nonce to number
      nonce: Number(web3Tx.nonce) || 0,
      from: web3Tx.from,
      to: web3Tx.to,
      // Convert BigInt value to string for large numbers
      value: web3Tx.value?.toString() || '0',
      // Convert BigInt gas to number (gas field, not gasLimit)
      gas: Number(web3Tx.gas || web3Tx.gasLimit) || 0,
      input: web3Tx.input || web3Tx.data || '0x',
      blockHash: web3Tx.blockHash,
      // Convert BigInt blockNumber to number (handle undefined properly)
      blockNumber: web3Tx.blockNumber !== undefined ? Number(web3Tx.blockNumber) : undefined,
      // Convert BigInt transactionIndex to number (handle undefined properly)
      transactionIndex: web3Tx.transactionIndex !== undefined ? Number(web3Tx.transactionIndex) : undefined,
      // Convert BigInt gasPrice to string
      gasPrice: web3Tx.gasPrice?.toString(),
      // Convert BigInt chainId to number (handle undefined properly)
      chainId: web3Tx.chainId !== undefined ? Number(web3Tx.chainId) : undefined,
      // Signature fields - convert BigInt v to string
      v: web3Tx.v?.toString(),
      r: web3Tx.r,
      s: web3Tx.s,
      // Convert BigInt type to string
      type: web3Tx.type?.toString() || '0',
      // EIP-1559 fields - convert BigInt to string
      maxFeePerGas: web3Tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: web3Tx.maxPriorityFeePerGas?.toString(),
      // EIP-2930 access list
      accessList: web3Tx.accessList,
      // EIP-4844 blob transaction fields - convert BigInt to string
      maxFeePerBlobGas: web3Tx.maxFeePerBlobGas?.toString(),
      blobVersionedHashes: web3Tx.blobVersionedHashes,
    };
  }
}
