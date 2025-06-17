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
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private requestId = 1;

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
      rateLimits: this.rateLimiter.getStats(),
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
    if (this.isWebSocketConnected && this._wsClient) {
      const wsProvider = this._wsClient.currentProvider;
      if (wsProvider && typeof wsProvider.send === 'function') {
        // Use Web3.js batch request capabilities
        return new Promise((resolve, reject) => {
          const batch = new this._wsClient.BatchRequest();
          const results: any[] = [];
          let completedCount = 0;

          calls.forEach((call, index) => {
            batch.add(
              this._wsClient.eth[call.method.replace('eth_', 'get')](...call.params, (error: any, result: any) => {
                if (error) {
                  reject(error);
                  return;
                }
                // Handle null/undefined results
                results[index] = result === null || result === undefined ? null : result;
                completedCount++;
                if (completedCount === calls.length) {
                  resolve(results);
                }
              })
            );
          });

          batch.execute();
        });
      }
    }

    // Fallback to HTTP batch request
    const response = await fetch(this.httpUrl, {
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
    return resultsArray.map((result: any) => {
      if (result === null || result === undefined) {
        return null;
      }
      if (result.error) {
        throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
      }
      return result.result;
    });
  }

  /**
   * Checks if WebSocket connection is healthy
   */
  public async healthcheckWebSocket(): Promise<boolean> {
    if (!this._wsClient || !this.isWebSocketConnected) {
      return false;
    }

    try {
      // Check if WebSocket provider is still connected
      const provider = this._wsClient.currentProvider;
      if (provider && provider.connection && provider.connection.readyState !== WebSocket.OPEN) {
        this.isWebSocketConnected = false;
        return false;
      }

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

    // Validate chainId after connection
    try {
      const connectedChainId = await this._httpClient.eth.getChainId();
      const expectedChainId = this.network.chainId;

      if (Number(connectedChainId) !== expectedChainId) {
        throw new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${connectedChainId}`);
      }
    } catch (error) {
      throw new Error(`Chain validation failed: ${error}`);
    }

    // Connect WebSocket if URL is provided
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
        const provider = this._wsClient.currentProvider;

        // Set up one-time close handler for cleanup
        const handleClose = () => {
          this._wsClient = undefined;
          resolve();
        };

        if (provider && typeof provider.disconnect === 'function') {
          try {
            // Add temporary close listener
            provider.on('close', handleClose);

            // Attempt graceful close
            provider.disconnect(1000, 'Client disconnecting');
          } catch (error) {
            // Force cleanup on error
            provider.removeListener('close', handleClose);
            this._wsClient = undefined;
            resolve();
          }

          // Timeout to prevent hanging on close
          setTimeout(() => {
            if (this._wsClient) {
              provider.removeListener('close', handleClose);
              this._wsClient = undefined;
              resolve();
            }
          }, 5000);
        } else {
          // No proper disconnect method
          this._wsClient = undefined;
          resolve();
        }
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
        const wsProviderOptions: any = {
          reconnect: {
            auto: false, // ConnectionManager handles reconnection
            delay: 1000,
            maxAttempts: 1,
          },
        };

        const wsProvider = new Web3.providers.WebsocketProvider(this.wsUrl!, wsProviderOptions);
        this._wsClient = new Web3(wsProvider);

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

            // Validate chainId after connection (Web3.js doesn't do this automatically)
            const connectedChainId = await this._wsClient.eth.getChainId();
            const expectedChainId = this.network.chainId;

            if (Number(connectedChainId) !== expectedChainId) {
              if (!isResolved) {
                isResolved = true;
                this.isWebSocketConnected = false;
                clearTimeout(timeoutId);
                cleanup();
                reject(new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${connectedChainId}`));
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
            reject(new Error(`WebSocket closed during connection: ${event.code} ${event.reason || 'Unknown reason'}`));
          }
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

    let subscription: any = null;

    // Use Web3.js native block subscription
    this._wsClient.eth
      .subscribe('newBlockHeaders')
      .then((sub: any) => {
        subscription = sub;

        sub.on('data', (blockHeader: any) => {
          callback(Number(blockHeader.number));
        });

        sub.on('error', (error: any) => {
          // console.error('Web3.js block subscription error:', error);
          return;
        });
      })
      .catch((error: any) => {
        throw error;
      });

    return {
      unsubscribe: () => {
        if (subscription) {
          subscription.unsubscribe((error: any, success: boolean) => {
            // if (error) {
            //   console.warn('Error unsubscribing from Web3.js blocks:', error);
            // }
          });
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

    let subscription: any = null;

    // Use Web3.js native pending transaction subscription
    this._wsClient.eth
      .subscribe('pendingTransactions')
      .then((sub: any) => {
        subscription = sub;

        sub.on('data', (txHash: string) => {
          callback(txHash);
        });

        sub.on('error', (error: any) => {
          // console.error('Web3.js pending transactions subscription error:', error);
          return;
        });
      })
      .catch((error: any) => {
        throw error;
      });

    return {
      unsubscribe: () => {
        if (subscription) {
          subscription.unsubscribe((error: any, success: boolean) => {
            // if (error) {
            //   console.warn('Error unsubscribing from Web3.js pending transactions:', error);
            // }
          });
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

    let subscription: any = null;

    // Use Web3.js native logs subscription
    this._wsClient.eth
      .subscribe('logs', options)
      .then((sub: any) => {
        subscription = sub;

        sub.on('data', callback);

        sub.on('error', (error: any) => {
          // console.error('Web3.js logs subscription error:', error);
          return;
        });
      })
      .catch((error: any) => {
        throw error;
      });

    return {
      unsubscribe: () => {
        if (subscription) {
          subscription.unsubscribe((error: any, success: boolean) => {
            // if (error) {
            //   console.warn('Error unsubscribing from Web3.js logs:', error);
            // }
          });
        }
      },
    };
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
              return this.normalizeRawBlock(block);
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
              return this.normalizeRawBlock(block);
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
          .filter(Boolean);
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(heights, batchRequestFn);
  }

  /**
   * Gets all transaction receipts for a block using eth_getBlockReceipts
   */
  public async getBlockReceipts(blockNumber: number | string): Promise<UniversalTransactionReceipt[]> {
    const blockId = typeof blockNumber === 'number' ? `0x${blockNumber.toString(16)}` : blockNumber;

    const call = {
      method: 'eth_getBlockReceipts',
      params: [blockId],
    };

    try {
      const rawReceipts = await this.rateLimiter.executeRequest(() =>
        this.directBatchRpcCall([call]).then((results) => results[0])
      );

      if (!rawReceipts || !Array.isArray(rawReceipts)) {
        return [];
      }

      return rawReceipts.map((receipt) => this.normalizeRawReceipt(receipt));
    } catch (error) {
      // Fallback to individual receipt fetching if eth_getBlockReceipts is not supported
      throw new Error(`eth_getBlockReceipts failed: ${error}`);
    }
  }

  /**
   * Gets receipts for multiple blocks using batch eth_getBlockReceipts calls
   */
  public async getManyBlocksReceipts(blockNumbers: (number | string)[]): Promise<UniversalTransactionReceipt[][]> {
    if (blockNumbers.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchBlockNumbers: (number | string)[]): Promise<UniversalTransactionReceipt[][]> => {
      const calls = batchBlockNumbers.map((blockNumber) => ({
        method: 'eth_getBlockReceipts',
        params: [typeof blockNumber === 'number' ? `0x${blockNumber.toString(16)}` : blockNumber],
      }));

      try {
        const rawBlocksReceipts = await this.directBatchRpcCall(calls);

        return rawBlocksReceipts.map((rawReceipts) => {
          if (!rawReceipts || !Array.isArray(rawReceipts)) {
            return [];
          }
          return rawReceipts.map((receipt) => this.normalizeRawReceipt(receipt));
        });
      } catch (batchError) {
        throw batchError;
      }
    };

    return await this.rateLimiter.executeBatchRequests(blockNumbers, batchRequestFn);
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
    const web3Receipt = await this.rateLimiter.executeRequest(() =>
      this.executeWithFallback((web3) => web3.eth.getTransactionReceipt(hash))
    );

    if (!web3Receipt) {
      throw new Error(`Transaction receipt ${hash} not found`);
    }

    return this.normalizeReceipt(web3Receipt);
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
   * Normalizes web3.js v4 block object to UniversalBlock format
   * Handles BigInt values and web3.js v4 specific field types
   */
  private normalizeBlock(web3Block: any): UniversalBlock {
    return {
      hash: web3Block.hash,
      parentHash: web3Block.parentHash,
      blockNumber: Number(web3Block.blockNumber || web3Block.number),
      nonce: web3Block.nonce,
      sha3Uncles: web3Block.sha3Uncles,
      logsBloom: web3Block.logsBloom,
      transactionsRoot: web3Block.transactionsRoot,
      stateRoot: web3Block.stateRoot,
      receiptsRoot: web3Block.receiptsRoot,
      miner: web3Block.miner,
      difficulty: web3Block.difficulty?.toString() || '0',
      totalDifficulty: web3Block.totalDifficulty?.toString() || '0',
      extraData: web3Block.extraData,
      size: Number(web3Block.size) || 0,
      gasLimit: Number(web3Block.gasLimit) || 0,
      gasUsed: Number(web3Block.gasUsed) || 0,
      timestamp: Number(web3Block.timestamp) || 0,
      uncles: web3Block.uncles || [],
      baseFeePerGas: web3Block.baseFeePerGas?.toString(),
      withdrawals: web3Block.withdrawals,
      withdrawalsRoot: web3Block.withdrawalsRoot,
      blobGasUsed: web3Block.blobGasUsed?.toString(),
      excessBlobGas: web3Block.excessBlobGas?.toString(),
      parentBeaconBlockRoot: web3Block.parentBeaconBlockRoot,
      transactions: web3Block.transactions?.map((tx: any) => {
        if (typeof tx === 'string') {
          return tx;
        }
        return this.normalizeTransaction(tx);
      }),
    };
  }

  /**
   * Normalizes raw JSON-RPC block response (used for batch calls)
   */
  private normalizeRawBlock(rawBlock: any): UniversalBlock {
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
   * Normalizes web3.js v4 transaction object to UniversalTransaction format
   */
  private normalizeTransaction(web3Tx: any): UniversalTransaction {
    return {
      hash: web3Tx.hash,
      nonce: Number(web3Tx.nonce) || 0,
      from: web3Tx.from,
      to: web3Tx.to,
      value: web3Tx.value?.toString() || '0',
      gas: Number(web3Tx.gas || web3Tx.gasLimit) || 0,
      input: web3Tx.input || web3Tx.data || '0x',
      blockHash: web3Tx.blockHash,
      blockNumber: web3Tx.blockNumber !== undefined ? Number(web3Tx.blockNumber) : undefined,
      transactionIndex: web3Tx.transactionIndex !== undefined ? Number(web3Tx.transactionIndex) : undefined,
      gasPrice: web3Tx.gasPrice?.toString(),
      chainId: web3Tx.chainId !== undefined ? Number(web3Tx.chainId) : undefined,
      v: web3Tx.v?.toString(),
      r: web3Tx.r,
      s: web3Tx.s,
      type: web3Tx.type?.toString() || '0',
      maxFeePerGas: web3Tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: web3Tx.maxPriorityFeePerGas?.toString(),
      accessList: web3Tx.accessList,
      maxFeePerBlobGas: web3Tx.maxFeePerBlobGas?.toString(),
      blobVersionedHashes: web3Tx.blobVersionedHashes,
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
   * Normalizes web3.js v4 transaction receipt to UniversalTransactionReceipt
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
      blobGasUsed: web3Receipt.blobGasUsed?.toString(),
      blobGasPrice: web3Receipt.blobGasPrice?.toString(),
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
      status: rawReceipt.status ? '0x1' : '0x0',
      type: rawReceipt.type?.toString() || '0x0',
      effectiveGasPrice: rawReceipt.effectiveGasPrice ? parseInt(rawReceipt.effectiveGasPrice, 16) : 0,
      blobGasUsed: rawReceipt.blobGasUsed,
      blobGasPrice: rawReceipt.blobGasPrice,
    };
  }
}
