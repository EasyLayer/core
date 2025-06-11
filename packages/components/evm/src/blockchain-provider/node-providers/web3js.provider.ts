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
    const blockNumber = await this.rateLimiter.executeRequest(() => this._httpClient.eth.getBlockNumber());
    return Number(blockNumber);
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const web3Block = await this.rateLimiter.executeRequest(() =>
      this._httpClient.eth.getBlock(blockNumber, fullTransactions)
    );

    if (!web3Block) {
      throw new Error(`Block ${blockNumber} not found`);
    }

    return this.normalizeBlock(web3Block);
  }

  public async getOneBlockHashByHeight(height: number): Promise<string> {
    const block = await this.rateLimiter.executeRequest<UniversalBlock>(() =>
      this._httpClient.eth.getBlock(height, false)
    );

    if (!block) {
      throw new Error(`Block ${height} not found`);
    }

    return block.hash;
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const web3Block = await this.rateLimiter.executeRequest(() =>
      this._httpClient.eth.getBlock(hash, fullTransactions)
    );

    if (!web3Block) {
      throw new Error(`Block ${hash} not found`);
    }

    return this.normalizeBlock(web3Block);
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.eth.getBlock(hash, fullTransactions));

    const web3Blocks = await this.rateLimiter.executeBatchRequests(requestFns);

    return web3Blocks.filter((block) => block !== null).map((block) => this.normalizeBlock(block));
  }

  public async getManyHashesByHeights(heights: number[]): Promise<string[]> {
    const requestFns = heights.map((height) => () => this._httpClient.eth.getBlock(height));

    const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
    return blocks.map((block: any) => block.hash).filter((hash): hash is string => !!hash);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    const requestFns = heights.map((height) => () => this._httpClient.eth.getBlock(height, fullTransactions));

    const web3Blocks = await this.rateLimiter.executeBatchRequests(requestFns);

    return web3Blocks.filter((block) => block !== null).map((block) => this.normalizeBlock(block));
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    const genesisHeight = 0;
    const hasGenesis = heights.includes(genesisHeight);

    if (hasGenesis) {
      // Get statistics for the genesis block
      const genesisBlock = await this.rateLimiter.executeRequest<UniversalBlock>(() =>
        this._httpClient.eth.getBlock(genesisHeight, false)
      );

      const genesisStats = {
        number: Number(genesisBlock.number),
        hash: genesisBlock.hash,
        size: Number(genesisBlock.size) || 0,
      };

      // Process the remaining blocks, excluding genesis
      const filteredHeights = heights.filter((height) => height !== genesisHeight);
      const requestFns = filteredHeights.map((height) => () => this._httpClient.eth.getBlock(height, false));

      const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
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
      const requestFns = heights.map((height) => () => this._httpClient.eth.getBlock(height, false));

      const blocks = await this.rateLimiter.executeBatchRequests(requestFns);
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
    const web3Tx = await this.rateLimiter.executeRequest(() => this._httpClient.eth.getTransaction(hash));

    if (!web3Tx) {
      throw new Error(`Transaction ${hash} not found`);
    }

    return this.normalizeTransaction(web3Tx);
  }

  public async getManyTransactionsByHashes(hashes: Hash[]): Promise<UniversalTransaction[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.eth.getTransaction(hash));

    const web3Transactions = await this.rateLimiter.executeBatchRequests(requestFns);

    return web3Transactions.filter((tx) => tx !== null).map((tx) => this.normalizeTransaction(tx));
  }

  public async getTransactionReceipt(hash: Hash): Promise<UniversalTransactionReceipt> {
    const web3Receipt = await this.rateLimiter.executeRequest(() => this._httpClient.eth.getTransactionReceipt(hash));

    if (!web3Receipt) {
      throw new Error(`Transaction receipt ${hash} not found`);
    }

    // Normalize web3 receipt to UniversalTransactionReceipt
    return this.normalizeReceipt(web3Receipt);
  }

  public async getManyTransactionReceipts(hashes: Hash[]): Promise<UniversalTransactionReceipt[]> {
    const requestFns = hashes.map((hash) => () => this._httpClient.eth.getTransactionReceipt(hash));

    const web3Receipts = await this.rateLimiter.executeBatchRequests(requestFns);

    return web3Receipts.filter((receipt) => receipt !== null).map((receipt) => this.normalizeReceipt(receipt));
  }

  /**
   * Normalizes web3.js transaction receipt to UniversalTransactionReceipt
   */
  private normalizeReceipt(web3Receipt: any): UniversalTransactionReceipt {
    return {
      transactionHash: web3Receipt.transactionHash,
      transactionIndex: Number(web3Receipt.transactionIndex),
      blockHash: web3Receipt.blockHash,
      blockNumber: Number(web3Receipt.blockNumber),
      from: web3Receipt.from,
      to: web3Receipt.to,
      cumulativeGasUsed: Number(web3Receipt.cumulativeGasUsed),
      gasUsed: Number(web3Receipt.gasUsed),
      contractAddress: web3Receipt.contractAddress,
      logs:
        web3Receipt.logs?.map((log: any) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: Number(log.blockNumber),
          transactionHash: log.transactionHash,
          transactionIndex: Number(log.transactionIndex),
          blockHash: log.blockHash,
          logIndex: Number(log.logIndex),
          removed: log.removed || false,
        })) || [],
      logsBloom: web3Receipt.logsBloom,
      status: web3Receipt.status ? '0x1' : '0x0',
      type: web3Receipt.type?.toString() || '0x0',
      effectiveGasPrice: Number(web3Receipt.effectiveGasPrice || 0),
      blobGasUsed: web3Receipt.blobGasUsed?.toString?.(),
      blobGasPrice: web3Receipt.blobGasPrice?.toString?.(),
    };
  }

  /**
   * Normalizes web3.js block object to UniversalBlock format
   * Handles web3.js specific field types and naming conventions
   */
  private normalizeBlock(web3Block: any): UniversalBlock {
    return {
      hash: web3Block.hash,
      parentHash: web3Block.parentHash,

      // Handle both number and blockNumber fields
      blockNumber: Number(web3Block.blockNumber || web3Block.number),

      nonce: web3Block.nonce,
      sha3Uncles: web3Block.sha3Uncles,
      logsBloom: web3Block.logsBloom,
      transactionsRoot: web3Block.transactionsRoot,
      stateRoot: web3Block.stateRoot,
      receiptsRoot: web3Block.receiptsRoot,
      miner: web3Block.miner,

      // Convert to string for large numbers
      difficulty: web3Block.difficulty?.toString() || '0',
      totalDifficulty: web3Block.totalDifficulty?.toString() || '0',

      extraData: web3Block.extraData,

      // Ensure numeric values are properly converted
      size: Number(web3Block.size) || 0,
      gasLimit: Number(web3Block.gasLimit) || 0,
      gasUsed: Number(web3Block.gasUsed) || 0,
      timestamp: Number(web3Block.timestamp) || 0,

      uncles: web3Block.uncles || [],

      // EIP-1559 fields
      baseFeePerGas: web3Block.baseFeePerGas?.toString(),

      // Shanghai fork fields
      withdrawals: web3Block.withdrawals,
      withdrawalsRoot: web3Block.withdrawalsRoot,

      // Cancun fork fields
      blobGasUsed: web3Block.blobGasUsed?.toString(),
      excessBlobGas: web3Block.excessBlobGas?.toString(),
      parentBeaconBlockRoot: web3Block.parentBeaconBlockRoot,

      // Normalize transactions if present
      transactions: web3Block.transactions?.map((tx: any) => this.normalizeTransaction(tx)),
    };
  }

  /**
   * Normalizes web3.js transaction object to UniversalTransaction format
   * Handles web3.js specific field types and ensures proper data conversion
   */
  private normalizeTransaction(web3Tx: any): UniversalTransaction {
    return {
      hash: web3Tx.hash,
      nonce: Number(web3Tx.nonce) || 0,
      from: web3Tx.from,
      to: web3Tx.to,

      // Convert value to string for large numbers
      value: web3Tx.value?.toString() || '0',

      gas: Number(web3Tx.gas) || 0,
      input: web3Tx.input || '0x',
      blockHash: web3Tx.blockHash,
      blockNumber: Number(web3Tx.blockNumber),
      transactionIndex: Number(web3Tx.transactionIndex),

      // Convert gas price to string
      gasPrice: web3Tx.gasPrice?.toString(),

      chainId: Number(web3Tx.chainId),

      // Signature fields
      v: web3Tx.v?.toString(),
      r: web3Tx.r,
      s: web3Tx.s,

      // Transaction type
      type: web3Tx.type?.toString() || '0',

      // EIP-1559 fields
      maxFeePerGas: web3Tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: web3Tx.maxPriorityFeePerGas?.toString(),

      // EIP-2930 access list
      accessList: web3Tx.accessList,

      // EIP-4844 blob transaction fields
      maxFeePerBlobGas: web3Tx.maxFeePerBlobGas?.toString(),
      blobVersionedHashes: web3Tx.blobVersionedHashes,
    };
  }
}
