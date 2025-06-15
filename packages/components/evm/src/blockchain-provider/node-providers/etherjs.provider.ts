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
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private requestId = 1;

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
      await this.rateLimiter.executeRequest(() => this.getActiveProvider().getBlockNumber());
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Gets the active provider - WebSocket if available, otherwise HTTP
   */
  private getActiveProvider(): ethers.JsonRpcProvider {
    if (this.isWebSocketConnected && this._wsClient) {
      return this._wsClient;
    }
    return this._httpClient;
  }

  /**
   * Executes a request with automatic WebSocket/HTTP fallback
   */
  private async executeWithFallback<T>(operation: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
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
   * Makes direct JSON-RPC batch call for better performance
   */
  private async directBatchRpcCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    const payload = calls.map((call) => ({
      jsonrpc: '2.0',
      method: call.method,
      params: call.params,
      id: this.requestId++,
    }));

    // Use WebSocket if available, otherwise HTTP
    let response: Response;
    if (this.isWebSocketConnected && this._wsClient && this._wsClient.websocket?.readyState === WebSocket.OPEN) {
      // For WebSocket, we need to implement the batch manually
      const results = await Promise.all(calls.map((call) => this._wsClient!.send(call.method, call.params)));
      // Filter out null/undefined results and handle errors
      const processedResults = results.map((result: any) => {
        if (result === null || result === undefined) {
          return null;
        }
        if (result && result.error) {
          throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
        }
        return result;
      });
      return Array.isArray(processedResults) ? processedResults : [];
    } else {
      // Use HTTP for batch requests
      response = await fetch(this.httpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const results = await response.json();
      // Handle both array and single response cases
      const resultsArray = Array.isArray(results) ? results : [results];
      const processedResults = resultsArray.map((result: any) => {
        if (result === null || result === undefined) {
          return null;
        }
        if (result.error) {
          throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
        }
        return result.result;
      });
      return Array.isArray(processedResults) ? processedResults : [];
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
      if (this._wsClient.websocket?.readyState !== WebSocket.OPEN) {
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

    if (this.wsUrl) {
      await this.connectWebSocket();
    }
  }

  public async disconnect(): Promise<void> {
    await this.disconnectWebSocket();
  }

  /**
   * Reconnects WebSocket connection
   * This method is called by ConnectionManager when WebSocket health check fails
   */
  public async reconnectWebSocket(): Promise<void> {
    try {
      // First, safely disconnect existing WebSocket
      await this.disconnectWebSocket();

      // Add a small delay before reconnecting to avoid rapid reconnection attempts
      await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));

      // Check if we haven't exceeded max reconnection attempts
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        throw new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`);
      }

      // Increment reconnection attempts counter
      this.reconnectAttempts++;

      // Establish new WebSocket connection
      if (this.wsUrl) {
        await this.connectWebSocket();
      } else {
        throw new Error('WebSocket URL not available for reconnection');
      }
    } catch (error) {
      // Exponential backoff for reconnection delay
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000); // Max 30 seconds

      throw error;
    }
  }

  /**
   * Safely disconnects WebSocket connection
   */
  private async disconnectWebSocket(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Mark WebSocket as disconnected immediately
      this.isWebSocketConnected = false;

      if (this._wsClient) {
        // Set up one-time close handler for cleanup
        const handleClose = () => {
          this._wsClient = undefined;
          resolve();
        };

        // Add temporary close listener
        this._wsClient.websocket?.addEventListener('close', handleClose, { once: true });

        try {
          // Attempt graceful close using ethers destroy method
          this._wsClient.destroy();
        } catch (error) {
          // Force cleanup on error
          this._wsClient.websocket?.removeEventListener('close', handleClose);
          this._wsClient = undefined;
          resolve();
        }

        // Timeout to prevent hanging on close
        setTimeout(() => {
          if (this._wsClient) {
            this._wsClient.websocket?.removeEventListener('close', handleClose);
            this._wsClient = undefined;
            resolve();
          }
        }, 5000);
      } else {
        // No WebSocket to disconnect
        resolve();
      }
    });
  }

  /**
   * Resets reconnection state after successful connection
   */
  private resetReconnectionState(): void {
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000; // Reset to initial delay
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.wsUrl) {
      throw new Error('WebSocket URL not provided');
    }

    return new Promise<void>((resolve, reject) => {
      let isResolved = false;
      let timeoutId: NodeJS.Timeout;

      try {
        // Use chainId from networkConfig for better compatibility
        const networkIdentifier = this.network.chainId;
        this._wsClient = new ethers.WebSocketProvider(this.wsUrl!, networkIdentifier);

        timeoutId = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            cleanup();
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);

        const handleOpen = async () => {
          if (isResolved) return;

          try {
            // Small delay for stabilization
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Validate chainId after WebSocket connection
            const connectedChainId = await this._wsClient!.send('eth_chainId', []);
            const expectedChainId = this.network.chainId;
            const parsedChainId = parseInt(connectedChainId, 16);

            if (parsedChainId !== expectedChainId) {
              if (!isResolved) {
                isResolved = true;
                this.isWebSocketConnected = false;
                clearTimeout(timeoutId);
                cleanup();
                reject(new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${parsedChainId}`));
              }
              return;
            }

            if (!isResolved) {
              isResolved = true;
              this.isWebSocketConnected = true;
              this.resetReconnectionState();
              clearTimeout(timeoutId);
              cleanup();
              resolve();
            }
          } catch (error) {
            if (!isResolved) {
              isResolved = true;
              this.isWebSocketConnected = false;
              clearTimeout(timeoutId);
              cleanup();
              reject(new Error(`WebSocket validation error: ${error}`));
            }
          }
        };

        const handleError = (error: any) => {
          if (!isResolved) {
            isResolved = true;
            this.isWebSocketConnected = false;
            clearTimeout(timeoutId);
            cleanup();
            reject(new Error(`WebSocket connection error: ${error.message || error}`));
          }
        };

        const handleClose = (event: CloseEvent) => {
          this.isWebSocketConnected = false;

          // If connection closed during connection setup
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            cleanup();
            reject(new Error(`WebSocket closed during connection: ${event.code} ${event.reason}`));
          }
        };

        const cleanup = () => {
          if (this._wsClient?.websocket) {
            this._wsClient.websocket.removeEventListener('open', handleOpen);
            this._wsClient.websocket.removeEventListener('error', handleError);
            this._wsClient.websocket.removeEventListener('close', handleClose);
          }
        };

        // Check if websocket is already open
        if (this._wsClient.websocket?.readyState === WebSocket.OPEN) {
          this.isWebSocketConnected = true;
          clearTimeout(timeoutId);
          resolve();
          return;
        }

        // Set up event listeners
        if (this._wsClient.websocket) {
          this._wsClient.websocket.addEventListener('open', handleOpen);
          this._wsClient.websocket.addEventListener('error', handleError);
          this._wsClient.websocket.addEventListener('close', handleClose);
        } else {
          // If websocket is not immediately available, wait a bit and check again
          setTimeout(() => {
            if (this._wsClient?.websocket) {
              this._wsClient.websocket.addEventListener('open', handleOpen);
              this._wsClient.websocket.addEventListener('error', handleError);
              this._wsClient.websocket.addEventListener('close', handleClose);
            } else {
              clearTimeout(timeoutId);
              reject(new Error('WebSocket not available'));
            }
          }, 100);
        }
      } catch (error) {
        isResolved = true;
        this.isWebSocketConnected = false;
        reject(error);
      }
    });
  }

  // ===== SUBSCRIPTION METHODS =====

  /**
   * Subscribes to new block events via WebSocket
   * Returns a subscription object with unsubscribe method
   */
  public subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe: () => void } {
    if (!this.isWebSocketConnected || !this._wsClient) {
      throw new Error('WebSocket connection is not available for subscriptions');
    }

    // Use ethers.js native block subscription
    this._wsClient.on('block', callback);

    return {
      unsubscribe: () => {
        if (this._wsClient) {
          this._wsClient.off('block', callback);
        }
      },
    };
  }

  /**
   * Subscribes to new pending transactions via WebSocket
   */
  public subscribeToPendingTransactions(callback: (txHash: string) => void): { unsubscribe: () => void } {
    if (!this.isWebSocketConnected || !this._wsClient) {
      throw new Error('WebSocket connection is not available for subscriptions');
    }

    // Use ethers.js native pending transaction subscription
    this._wsClient.on('pending', callback);

    return {
      unsubscribe: () => {
        if (this._wsClient) {
          this._wsClient.off('pending', callback);
        }
      },
    };
  }

  /**
   * Subscribes to contract logs via WebSocket
   */
  public subscribeToLogs(
    options: {
      address?: string | string[];
      topics?: (string | string[] | null)[];
    },
    callback: (log: any) => void
  ): { unsubscribe: () => void } {
    if (!this.isWebSocketConnected || !this._wsClient) {
      throw new Error('WebSocket connection is not available for subscriptions');
    }

    // Create ethers.js filter
    const filter = {
      address: options.address,
      topics: options.topics,
    };

    // Use ethers.js native log subscription
    this._wsClient.on(filter, callback);

    return {
      unsubscribe: () => {
        if (this._wsClient) {
          this._wsClient.off(filter, callback);
        }
      },
    };
  }

  // ===== BLOCK METHODS =====

  public async getBlockHeight(): Promise<number> {
    return await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((provider) => provider.getBlockNumber())
    );
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const ethersBlock = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((provider) => provider.getBlock(blockNumber, fullTransactions))
    );

    if (!ethersBlock) {
      throw new Error(`Block ${blockNumber} not found`);
    }

    return this.normalizeBlock(ethersBlock);
  }

  public async getOneBlockHashByHeight(height: number): Promise<string> {
    const block = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback<any>((provider) => provider.getBlock(height, false))
    );

    if (!block) {
      throw new Error(`Block ${height} not found`);
    }

    return block.hash;
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const ethersBlock = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((provider) => provider.getBlock(hash, fullTransactions))
    );

    if (!ethersBlock) {
      throw new Error(`Block ${hash} not found`);
    }

    return this.normalizeBlock(ethersBlock);
  }

  // Use batch RPC for multiple blocks
  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    if (hashes.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHashes: string[]): Promise<UniversalBlock[]> => {
      const calls = batchHashes.map((hash) => ({
        method: 'eth_getBlockByHash',
        params: [hash, fullTransactions],
      }));

      try {
        const rawBlocks = await this.directBatchRpcCall(calls);
        // Ensure rawBlocks is an array
        if (!Array.isArray(rawBlocks)) {
          throw new Error('directBatchRpcCall did not return an array');
        }
        return rawBlocks
          .filter((block) => block !== null && block !== undefined && !block.error)
          .map((block) => {
            try {
              return this.normalizeEthersBlock(block);
            } catch (normalizeError) {
              return null;
            }
          })
          .filter((block): block is UniversalBlock => block !== null);
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(hashes, batchRequestFn);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    if (heights.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHeights: number[]): Promise<UniversalBlock[]> => {
      const calls = batchHeights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, fullTransactions],
      }));

      try {
        const rawBlocks = await this.directBatchRpcCall(calls);
        // Ensure rawBlocks is an array
        if (!Array.isArray(rawBlocks)) {
          throw new Error('directBatchRpcCall did not return an array');
        }
        return rawBlocks
          .filter((block) => block !== null && block !== undefined && !block.error)
          .map((block) => {
            try {
              return this.normalizeEthersBlock(block);
            } catch (normalizeError) {
              return null;
            }
          })
          .filter((block): block is UniversalBlock => block !== null);
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(heights, batchRequestFn);
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    if (heights.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHeights: number[]): Promise<any[]> => {
      const calls = batchHeights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, false],
      }));

      try {
        const rawBlocks = await this.directBatchRpcCall(calls);
        // Ensure rawBlocks is an array
        if (!Array.isArray(rawBlocks)) {
          throw new Error('directBatchRpcCall did not return an array');
        }
        return rawBlocks
          .filter((block) => block !== null && block !== undefined && !block.error)
          .map((block: any) => {
            try {
              return {
                number: parseInt(block.number || block.blockNumber, 16),
                hash: block.hash,
                size: parseInt(block.size, 16),
              };
            } catch (parseError) {
              return null;
            }
          })
          .filter((stat): stat is any => stat !== null);
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(heights, batchRequestFn);
  }

  // ===== TRANSACTION METHODS =====

  public async getOneTransactionByHash(hash: Hash): Promise<UniversalTransaction> {
    const ethersTx = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((provider) => provider.getTransaction(hash))
    );

    if (!ethersTx) {
      throw new Error(`Transaction ${hash} not found`);
    }

    return this.normalizeTransaction(ethersTx);
  }

  // Use batch RPC for multiple transactions
  public async getManyTransactionsByHashes(hashes: Hash[]): Promise<UniversalTransaction[]> {
    if (hashes.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHashes: string[]): Promise<UniversalTransaction[]> => {
      const calls = batchHashes.map((hash) => ({
        method: 'eth_getTransactionByHash',
        params: [hash],
      }));

      try {
        const rawTransactions = await this.directBatchRpcCall(calls);
        // Ensure rawTransactions is an array
        if (!Array.isArray(rawTransactions)) {
          throw new Error('directBatchRpcCall did not return an array');
        }
        return rawTransactions
          .filter((tx) => tx !== null && tx !== undefined && !tx.error)
          .map((tx) => {
            try {
              return this.normalizeRawTransaction(tx);
            } catch (normalizeError) {
              return null;
            }
          })
          .filter((tx): tx is UniversalTransaction => tx !== null);
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(hashes, batchRequestFn);
  }

  public async getTransactionReceipt(hash: Hash): Promise<UniversalTransactionReceipt> {
    const ethersReceipt = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((provider) => provider.getTransactionReceipt(hash))
    );

    if (!ethersReceipt) {
      throw new Error(`Transaction receipt ${hash} not found`);
    }

    return this.normalizeReceipt(ethersReceipt);
  }

  // Use batch RPC for multiple receipts
  public async getManyTransactionReceipts(hashes: Hash[]): Promise<UniversalTransactionReceipt[]> {
    if (hashes.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHashes: string[]): Promise<UniversalTransactionReceipt[]> => {
      const calls = batchHashes.map((hash) => ({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      }));

      try {
        const rawReceipts = await this.directBatchRpcCall(calls);
        // Ensure rawReceipts is an array
        if (!Array.isArray(rawReceipts)) {
          throw new Error('directBatchRpcCall did not return an array');
        }
        return rawReceipts
          .filter((receipt) => receipt !== null && receipt !== undefined && !receipt.error)
          .map((receipt) => {
            try {
              return this.normalizeRawReceipt(receipt);
            } catch (normalizeError) {
              return null;
            }
          })
          .filter((receipt): receipt is UniversalTransactionReceipt => receipt !== null);
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(hashes, batchRequestFn);
  }

  // ===== NORMALIZATION METHODS =====

  /**
   * Normalizes ethers.js Block object to UniversalBlock format
   */
  private normalizeBlock(ethersBlock: any): UniversalBlock {
    // In ethers v6, full transactions are in prefetchedTransactions
    let transactions;

    if (ethersBlock.prefetchedTransactions && ethersBlock.prefetchedTransactions.length > 0) {
      transactions = ethersBlock.prefetchedTransactions.map((tx: any) => this.normalizeTransaction(tx));
    } else if (ethersBlock.transactions) {
      transactions = ethersBlock.transactions;
    }

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
      difficulty: ethersBlock.difficulty?.toString() || '0',
      totalDifficulty: ethersBlock.totalDifficulty?.toString() || '0',
      extraData: ethersBlock.extraData,
      size: ethersBlock.size || 0,
      gasLimit: Number(ethersBlock.gasLimit) || 0,
      gasUsed: Number(ethersBlock.gasUsed) || 0,
      timestamp: ethersBlock.timestamp || 0,
      uncles: ethersBlock.uncles || [],
      baseFeePerGas: ethersBlock.baseFeePerGas?.toString(),
      withdrawals: ethersBlock.withdrawals,
      withdrawalsRoot: ethersBlock.withdrawalsRoot,
      blobGasUsed: ethersBlock.blobGasUsed?.toString(),
      excessBlobGas: ethersBlock.excessBlobGas?.toString(),
      parentBeaconBlockRoot: ethersBlock.parentBeaconBlockRoot,
      transactions,
    };
  }

  /**
   * Normalizes raw JSON-RPC block response (used for batch calls)
   */
  private normalizeEthersBlock(rawBlock: any): UniversalBlock {
    return {
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      blockNumber: rawBlock.blockNumber
        ? parseInt(rawBlock.blockNumber, 16)
        : rawBlock.number
          ? parseInt(rawBlock.number, 16)
          : 0,
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
  }

  /**
   * Normalizes ethers.js TransactionResponse to UniversalTransaction format
   */
  private normalizeTransaction(ethersTx: any): UniversalTransaction {
    return {
      hash: ethersTx.hash,
      nonce: ethersTx.nonce || 0,
      from: ethersTx.from,
      to: ethersTx.to,
      value: ethersTx.value?.toString() || '0',
      gas: Number(ethersTx.gasLimit) || 0,
      input: ethersTx.data || ethersTx.input || '0x',
      blockHash: ethersTx.blockHash,
      blockNumber: ethersTx.blockNumber,
      transactionIndex: ethersTx.transactionIndex ?? ethersTx.index,
      gasPrice: ethersTx.gasPrice?.toString(),
      chainId: ethersTx.chainId ? Number(ethersTx.chainId) : undefined,
      v: ethersTx.signature?.v?.toString() || ethersTx.v?.toString(),
      r: ethersTx.signature?.r || ethersTx.r,
      s: ethersTx.signature?.s || ethersTx.s,
      type: ethersTx.type?.toString() || '0',
      maxFeePerGas: ethersTx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: ethersTx.maxPriorityFeePerGas?.toString(),
      accessList: ethersTx.accessList,
      maxFeePerBlobGas: ethersTx.maxFeePerBlobGas?.toString(),
      blobVersionedHashes: ethersTx.blobVersionedHashes,
    };
  }

  /**
   * Normalizes raw JSON-RPC transaction response (used for batch calls)
   */
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
      effectiveGasPrice: Number(ethersReceipt.effectiveGasPrice || 0),
      blobGasUsed: ethersReceipt.blobGasUsed?.toString(),
      blobGasPrice: ethersReceipt.blobGasPrice?.toString(),
    };
  }

  /**
   * Normalizes raw JSON-RPC receipt response (used for batch calls)
   */
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
