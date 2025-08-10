import { ethers } from 'ethers';
import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import { NodeProviderTypes } from './interfaces';
import { EvmRateLimiter } from './rate-limiter';
import { EvmTrieVerifier } from './trie-verifier';
import type {
  UniversalBlockStats,
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  NetworkConfig,
} from './interfaces';
import { BlockchainErrorHandler } from './errors';

export interface EtherJSProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  network: NetworkConfig;
  /** Response timeout in milliseconds (default: 5000) */
  responseTimeout?: number;
}

export const createEtherJSProvider = (options: EtherJSProviderOptions): EtherJSProvider => {
  return new EtherJSProvider(options);
};

export class EtherJSProvider extends BaseNodeProvider<EtherJSProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.ETHERJS;
  private httpUrl: string;
  private wsUrl?: string;
  private network: NetworkConfig;
  private rateLimiter: EvmRateLimiter;
  private requestId = 1;
  private responseTimeout: number;

  constructor(options: EtherJSProviderOptions) {
    super(options);
    const url = new URL(options.httpUrl);
    this.httpUrl = url.toString();
    this.wsUrl = options.wsUrl;
    this.network = options.network;
    this.responseTimeout = options.responseTimeout ?? 5000;

    // Set WebSocket availability flag
    this._hasWebSocketUrl = !!this.wsUrl;

    // Create ethers Network object from our NetworkConfig
    const ethersNetwork = new ethers.Network(this.network.nativeCurrencySymbol, this.network.chainId);

    // Create FetchRequest with timeout for HTTP provider
    const fetchRequest = new ethers.FetchRequest(this.httpUrl);
    fetchRequest.timeout = this.responseTimeout;

    // Configure HTTP provider with network and FetchRequest
    this._httpClient = new ethers.JsonRpcProvider(fetchRequest, ethersNetwork);

    // Initialize WebSocket if URL provided
    if (this.wsUrl) {
      this.initializeWebSocket();
    }

    // Initialize rate limiter
    this.rateLimiter = new EvmRateLimiter(options.rateLimits);
  }

  get connectionOptions() {
    return {
      type: this.type,
      uniqName: this.uniqName,
      httpUrl: this.httpUrl,
      wsUrl: this.wsUrl,
      network: this.network,
      rateLimits: this.rateLimits,
    };
  }

  /**
   * Initialize WebSocket connection with event handlers
   */
  private initializeWebSocket(): void {
    if (!this.wsUrl) return;

    try {
      const ethersNetwork = new ethers.Network(this.network.nativeCurrencySymbol, this.network.chainId);
      this._wsClient = new ethers.WebSocketProvider(this.wsUrl, ethersNetwork);

      // Set up WebSocket event handlers
      this._wsClient.websocket.on('open', () => {
        this._isWebSocketConnected = true;
      });

      this._wsClient.websocket.on('close', () => {
        this._isWebSocketConnected = false;
      });

      this._wsClient.websocket.on('error', (error: any) => {
        this._isWebSocketConnected = false;
        // Don't throw here, just log for debugging
      });
    } catch (error) {
      this._isWebSocketConnected = false;
      // Don't throw during initialization, provider can still work with HTTP
    }
  }

  /**
   * Check WebSocket connection state without making requests
   */
  healthcheckWebSocket(): boolean {
    if (!this._hasWebSocketUrl || !this._wsClient) {
      return false;
    }

    // Check WebSocket ready state
    const ws = this._wsClient.websocket;
    return ws && ws.readyState === ws.READY_STATE_OPEN && this._isWebSocketConnected;
  }

  /**
   * Handle connection errors and attempt recovery
   */
  async handleConnectionError(error: any, methodName: string): Promise<void> {
    // This method is called by the connection manager when operations fail
    throw error; // Re-throw to let connection manager handle provider switching
  }

  public async healthcheck(): Promise<boolean> {
    try {
      const requests = [{ method: 'eth_blockNumber', params: [] as any[] }];

      // Always use HTTP for health checks to avoid WebSocket dependency
      const results = await this.rateLimiter.execute(requests, (calls) => this._batchRpcCall(calls));
      return !!results[0];
    } catch (error) {
      return false;
    }
  }

  public async connect(): Promise<void> {
    const health = await this.healthcheck();
    if (!health) {
      throw new Error('Cannot connect to the node');
    }

    // Validate chainId after connection
    try {
      const connectedChainId = await this._httpClient.send('eth_chainId', []);
      const expectedChainId = this.network.chainId;
      const parsedChainId = parseInt(connectedChainId, 16);

      if (parsedChainId !== expectedChainId) {
        throw new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${parsedChainId}`);
      }
    } catch (error) {
      throw new Error(`Chain validation failed: ${error}`);
    }

    // Initialize WebSocket if configured
    if (this._hasWebSocketUrl && !this._wsClient) {
      this.initializeWebSocket();
    }
  }

  public async disconnect(): Promise<void> {
    await this.rateLimiter.stop();

    if (this._wsClient) {
      this._wsClient.destroy();
      this._wsClient = undefined;
      this._isWebSocketConnected = false;
    }

    this._httpClient.destroy();
  }

  public async reconnectWebSocket(): Promise<void> {
    if (!this._hasWebSocketUrl || !this.wsUrl) {
      throw new Error('WebSocket URL not available for reconnection');
    }

    // Cleanup existing WebSocket
    if (this._wsClient) {
      this._wsClient.destroy();
      this._wsClient = undefined;
      this._isWebSocketConnected = false;
    }

    // Reinitialize WebSocket
    this.initializeWebSocket();

    // Wait a bit for connection to establish
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (!this.healthcheckWebSocket()) {
      throw new Error('Failed to reconnect WebSocket');
    }
  }

  /**
   * Execute request with automatic error handling and provider switching
   */
  private async executeWithErrorHandling<T>(operation: () => Promise<T>, methodName: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.handleConnectionError(error, methodName);
      throw error; // This will trigger provider switching in connection manager
    }
  }

  /**
   * Batch RPC call method for multiple requests via HTTP
   */
  private async _batchRpcCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    const payload = calls.map((call) => ({
      jsonrpc: '2.0',
      method: call.method,
      params: call.params,
      id: this.requestId++,
    }));

    const response = await fetch(this.httpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.responseTimeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const results = await response.json();
    const resultsArray = Array.isArray(results) ? results : [results];

    return resultsArray.map((result: any) => {
      if (result === null || result === undefined) {
        // IMPORTANT: in error case return null - preserves order
        return null;
      }
      if (result.error) {
        throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
      }
      return result.result;
    });
  }

  /**
   * Batch WebSocket call method for multiple requests via WebSocket
   */
  private async _batchWsCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    if (!this._wsClient || !this.healthcheckWebSocket()) {
      throw new Error('WebSocket client not available or not connected');
    }

    const results = await Promise.all(calls.map((call) => this._wsClient!.send(call.method, call.params)));

    return results.map((result: any) => {
      // IMPORTANT: in error case return null - preserves order
      if (result === null || result === undefined) {
        return null;
      }
      if (result && result.error) {
        throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
      }
      return result;
    });
  }

  /**
   * Subscribes to new block events via WebSocket
   * Returns a subscription object with unsubscribe method
   */
  public subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe: () => void } {
    if (!this._hasWebSocketUrl) {
      throw new Error('WebSocket is not configured for this provider');
    }

    if (!this._wsClient || !this.healthcheckWebSocket()) {
      throw new Error('WebSocket not available for subscriptions');
    }

    try {
      this._wsClient.on('block', callback);

      return {
        unsubscribe: () => {
          if (this._wsClient) {
            this._wsClient.off('block', callback);
          }
        },
      };
    } catch (error) {
      BlockchainErrorHandler.handleError(error, 'subscribeToNewBlocks', { provider: this.type, wsUrl: this.wsUrl });
    }
  }

  // ===== BLOCK METHODS =====

  public async getBlockHeight(): Promise<number> {
    return this.executeWithErrorHandling(async () => {
      const requests = [{ method: 'eth_blockNumber', params: [] as any[] }];

      // Prefer WebSocket if available and connected, otherwise use HTTP
      const batchCall =
        this._wsClient && this.healthcheckWebSocket()
          ? (calls: typeof requests) => this._batchWsCall(calls)
          : (calls: typeof requests) => this._batchRpcCall(calls);

      const results = await this.rateLimiter.execute(requests, batchCall);
      return parseInt(results[0], 16);
    }, 'getBlockHeight');
  }

  public async getManyBlocksByHeights(
    heights: number[],
    fullTransactions: boolean = false,
    verifyTrie: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    if (heights.length === 0) {
      return [];
    }

    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, fullTransactions],
      }));

      const batchCall =
        this._wsClient && this.healthcheckWebSocket()
          ? (calls: typeof requests) => this._batchWsCall(calls)
          : (calls: typeof requests) => this._batchRpcCall(calls);

      const rawBlocks = await this.rateLimiter.execute(requests, batchCall);

      // Process blocks with optional trie verification
      return await Promise.all(
        rawBlocks.map(async (block, index) => {
          if (block === null || block === undefined || block.error) {
            return null;
          }

          // Verify transactions trie if requested and we have full transactions
          if (verifyTrie && fullTransactions && block.transactions && block.transactionsRoot) {
            const isValid = await EvmTrieVerifier.verifyTransactionsRoot(block.transactions, block.transactionsRoot);
            if (!isValid) {
              throw new Error(
                `Transactions root verification failed for block ${heights[index]}. ` +
                  `Expected: ${block.transactionsRoot}, but computed root doesn't match.`
              );
            }
          }

          const normalizedBlock = this.normalizeRawBlock(block);

          // Guarantee blockNumber from known height
          if (normalizedBlock.blockNumber === undefined || normalizedBlock.blockNumber === null) {
            normalizedBlock.blockNumber = heights[index];
          }

          return normalizedBlock;
        })
      );
    }, 'getManyBlocksByHeights');
  }

  public async getManyBlocksByHashes(
    hashes: string[],
    fullTransactions: boolean = false
  ): Promise<(UniversalBlock | null)[]> {
    if (hashes.length === 0) {
      return [];
    }

    return this.executeWithErrorHandling(async () => {
      const requests = hashes.map((hash) => ({
        method: 'eth_getBlockByHash',
        params: [hash, fullTransactions],
      }));

      const batchCall =
        this._wsClient && this.healthcheckWebSocket()
          ? (calls: typeof requests) => this._batchWsCall(calls)
          : (calls: typeof requests) => this._batchRpcCall(calls);

      // Preserve order: rawBlocks[i] corresponds to hashes[i]
      // Don't filter - return null for missing blocks
      const rawBlocks = await this.rateLimiter.execute(requests, batchCall);

      return rawBlocks.map((block) => {
        if (block === null || block === undefined || block.error) {
          return null;
        }
        return this.normalizeRawBlock(block);
      });
    }, 'getManyBlocksByHashes');
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    if (heights.length === 0) {
      return [];
    }

    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, false],
      }));

      const batchCall =
        this._wsClient && this.healthcheckWebSocket()
          ? (calls: typeof requests) => this._batchWsCall(calls)
          : (calls: typeof requests) => this._batchRpcCall(calls);

      const rawBlocks = await this.rateLimiter.execute(requests, batchCall);

      // Preserve order: rawBlocks[i] corresponds to heights[i]
      // Guarantee number since we know the heights
      return rawBlocks.map((block, index) => {
        if (block === null || block === undefined || block.error) {
          return null;
        }

        const normalizedStats = this.normalizeBlockStats(block);

        // Guarantee number from known height
        if (normalizedStats.number === undefined || normalizedStats.number === null) {
          normalizedStats.number = heights[index]!;
        }

        return normalizedStats;
      });
    }, 'getManyBlocksStatsByHeights');
  }

  public async getManyBlocksReceipts(
    heights: number[],
    verifyTrie = false,
    receiptsRoots?: (string | undefined)[]
  ): Promise<UniversalTransactionReceipt[][]> {
    if (heights.length === 0) {
      return [];
    }

    return this.executeWithErrorHandling(async () => {
      const requests = heights.map((height) => ({
        method: 'eth_getBlockReceipts',
        params: [`0x${height.toString(16)}`],
      }));

      const batchCall =
        this._wsClient && this.healthcheckWebSocket()
          ? (calls: typeof requests) => this._batchWsCall(calls)
          : (calls: typeof requests) => this._batchRpcCall(calls);

      const rawBlocksReceipts = await this.rateLimiter.execute(requests, batchCall);

      // Process receipts with optional trie verification
      return await Promise.all(
        rawBlocksReceipts.map(async (rawReceipts, index) => {
          if (!rawReceipts || !Array.isArray(rawReceipts)) {
            return [];
          }

          const blockHeight = heights[index];
          const expectedReceiptsRoot = receiptsRoots?.[index];

          // Verify trie if requested and expected root is provided
          if (verifyTrie && expectedReceiptsRoot) {
            const isValid = await EvmTrieVerifier.verifyReceiptsRoot(rawReceipts, expectedReceiptsRoot);
            if (!isValid) {
              throw new Error(
                `Receipts root verification failed for block ${blockHeight}. ` +
                  `Expected: ${expectedReceiptsRoot}, but computed root doesn't match.`
              );
            }
          }

          return rawReceipts.map((receipt) => {
            const normalizedReceipt = this.normalizeRawReceipt(receipt);

            // Guarantee blockNumber in receipt from known block height
            if (normalizedReceipt.blockNumber === undefined || normalizedReceipt.blockNumber === null) {
              normalizedReceipt.blockNumber = blockHeight;
            }

            return normalizedReceipt;
          });
        })
      );
    }, 'getManyBlocksReceipts');
  }

  public async getManyBlocksWithReceipts(
    heights: string[] | number[],
    fullTransactions = false,
    verifyTrie = false
  ): Promise<((UniversalBlock & { receipts: UniversalTransactionReceipt[] }) | null)[]> {
    if (heights.length === 0) {
      return [];
    }

    return this.executeWithErrorHandling(async () => {
      const numericHeights = heights.map((h) => Number(h));

      // Get blocks first
      const rawBlocks = await this.getManyBlocksByHeights(
        numericHeights,
        fullTransactions,
        verifyTrie && fullTransactions // Only verify transactions if we have full transactions
      );

      // Extract receipts roots for verification if needed
      const receiptsRoots = verifyTrie ? rawBlocks.map((block) => block?.receiptsRoot) : undefined;

      // Get receipts for all requested heights (even if some blocks are null)
      const allBlocksReceipts = await this.getManyBlocksReceipts(numericHeights, verifyTrie, receiptsRoots);

      // Combine blocks with receipts, maintaining order
      return rawBlocks.map((rawBlock, index) => {
        if (rawBlock === null) {
          return null;
        }

        // Attach receipts to block
        const blockWithReceipts = {
          ...rawBlock,
          receipts: allBlocksReceipts[index] || [],
        };

        return blockWithReceipts;
      });
    }, 'getManyBlocksWithReceipts');
  }

  // ===== NORMALIZATION METHODS =====

  /**
   * Normalizes block stats from raw block data
   */
  private normalizeBlockStats(rawBlock: any): UniversalBlockStats {
    const gasLimit = parseInt(rawBlock.gasLimit, 16);
    const gasUsed = parseInt(rawBlock.gasUsed, 16);
    const gasUsedPercentage = gasLimit > 0 ? (gasUsed / gasLimit) * 100 : 0;

    return {
      hash: rawBlock.hash,
      number: parseInt(rawBlock.number || rawBlock.blockNumber, 16),
      size: parseInt(rawBlock.size, 16),
      gasLimit,
      gasUsed,
      gasUsedPercentage: Math.round(gasUsedPercentage * 100) / 100,
      timestamp: parseInt(rawBlock.timestamp, 16),
      transactionCount: rawBlock.transactions?.length || 0,
      baseFeePerGas: rawBlock.baseFeePerGas,
      blobGasUsed: rawBlock.blobGasUsed,
      excessBlobGas: rawBlock.excessBlobGas,
      miner: rawBlock.miner,
      difficulty: rawBlock.difficulty,
      parentHash: rawBlock.parentHash,
      unclesCount: rawBlock.uncles?.length || 0,
    };
  }

  private normalizeRawBlock(rawBlock: any): UniversalBlock {
    const block: UniversalBlock = {
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      nonce: rawBlock.nonce,
      sha3Uncles: rawBlock.sha3Uncles,
      logsBloom: rawBlock.logsBloom,
      transactionsRoot: rawBlock.transactionsRoot,
      stateRoot: rawBlock.stateRoot,
      receiptsRoot: rawBlock.receiptsRoot,
      miner: rawBlock.miner,
      difficulty: rawBlock.difficulty,
      totalDifficulty: rawBlock.totalDifficulty,
      extraData: rawBlock.extraData,
      size: parseInt(rawBlock.size, 16),
      gasLimit: parseInt(rawBlock.gasLimit, 16),
      gasUsed: parseInt(rawBlock.gasUsed, 16),
      timestamp: parseInt(rawBlock.timestamp, 16),
      uncles: rawBlock.uncles || [],
      baseFeePerGas: rawBlock.baseFeePerGas,
      withdrawals: rawBlock.withdrawals,
      withdrawalsRoot: rawBlock.withdrawalsRoot,
      blobGasUsed: rawBlock.blobGasUsed,
      excessBlobGas: rawBlock.excessBlobGas,
      parentBeaconBlockRoot: rawBlock.parentBeaconBlockRoot,
      transactions: rawBlock.transactions?.map((tx: any) =>
        typeof tx === 'string' ? tx : this.normalizeRawTransaction(tx)
      ),
    };

    // Only set blockNumber if it exists in raw data
    if (rawBlock.blockNumber !== undefined && rawBlock.blockNumber !== null) {
      block.blockNumber = parseInt(rawBlock.blockNumber, 16);
    } else if (rawBlock.number !== undefined && rawBlock.number !== null) {
      block.blockNumber = parseInt(rawBlock.number, 16);
    }

    return block;
  }

  private normalizeRawTransaction(rawTx: any): UniversalTransaction {
    const parseHexSafely = (value: string | undefined, fieldName: string): number => {
      if (!value) return 0;
      const parsed = parseInt(value, 16);
      if (isNaN(parsed)) {
        throw new Error(`Invalid hex value for ${fieldName}: ${value}`);
      }
      return parsed;
    };

    const parseHexOptional = (value: string | undefined): number | null => {
      if (!value) return null;
      const parsed = parseInt(value, 16);
      if (isNaN(parsed)) {
        throw new Error(`Invalid hex value: ${value}`);
      }
      return parsed;
    };

    return {
      hash: rawTx.hash,
      nonce: parseHexSafely(rawTx.nonce, 'nonce'),
      from: rawTx.from,
      to: rawTx.to,
      value: rawTx.value,
      gas: parseHexSafely(rawTx.gas, 'gas'),
      input: rawTx.input,
      blockHash: rawTx.blockHash,
      blockNumber: parseHexOptional(rawTx.blockNumber),
      transactionIndex: parseHexOptional(rawTx.transactionIndex),
      gasPrice: rawTx.gasPrice,
      chainId: rawTx.chainId ? parseHexSafely(rawTx.chainId, 'chainId') : undefined,
      v: rawTx.v,
      r: rawTx.r,
      s: rawTx.s,
      type: rawTx.type || '0x0',
      maxFeePerGas: rawTx.maxFeePerGas,
      maxPriorityFeePerGas: rawTx.maxPriorityFeePerGas,
      accessList: rawTx.accessList,
      maxFeePerBlobGas: rawTx.maxFeePerBlobGas,
      blobVersionedHashes: rawTx.blobVersionedHashes,
    };
  }

  private normalizeRawReceipt(rawReceipt: any): UniversalTransactionReceipt {
    return {
      transactionHash: rawReceipt.transactionHash,
      transactionIndex: parseInt(rawReceipt.transactionIndex, 16),
      blockHash: rawReceipt.blockHash,
      blockNumber: parseInt(rawReceipt.blockNumber, 16),
      from: rawReceipt.from,
      to: rawReceipt.to,
      cumulativeGasUsed: parseInt(rawReceipt.cumulativeGasUsed, 16),
      gasUsed: parseInt(rawReceipt.gasUsed, 16),
      contractAddress: rawReceipt.contractAddress,
      logs:
        rawReceipt.logs?.map((log: any) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: log.blockNumber ? parseInt(log.blockNumber, 16) : null,
          transactionHash: log.transactionHash,
          transactionIndex: log.transactionIndex ? parseInt(log.transactionIndex, 16) : null,
          blockHash: log.blockHash,
          logIndex: log.logIndex ? parseInt(log.logIndex, 16) : null,
          removed: log.removed || false,
        })) || [],
      logsBloom: rawReceipt.logsBloom,
      status: rawReceipt.status === '0x1' ? '0x1' : '0x0',
      type: rawReceipt.type || '0x0',
      effectiveGasPrice: rawReceipt.effectiveGasPrice ? parseInt(rawReceipt.effectiveGasPrice, 16) : 0,
      blobGasUsed: rawReceipt.blobGasUsed,
      blobGasPrice: rawReceipt.blobGasPrice,
    };
  }
}
