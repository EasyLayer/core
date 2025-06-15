import type { BaseNodeProviderOptions } from './base-node-provider';
import { BaseNodeProvider } from './base-node-provider';
import type { Hash } from './interfaces';
import { NodeProviderTypes } from './interfaces';
import { RateLimiter } from './rate-limiter';
import type {
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalLog,
  NetworkConfig,
} from './interfaces';

export interface JsonRpcProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  timeout?: number;
  network: NetworkConfig;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
}

export const createJsonRpcProvider = (options: JsonRpcProviderOptions): JsonRpcProvider => {
  return new JsonRpcProvider(options);
};

export class JsonRpcProvider extends BaseNodeProvider<JsonRpcProviderOptions> {
  readonly type: NodeProviderTypes = NodeProviderTypes.JSON_RPC;
  private httpUrl: string;
  private wsUrl?: string;
  private timeout: number;
  private network: NetworkConfig;
  private rateLimiter: RateLimiter;
  private requestId = 1;

  // WebSocket specific properties
  private isWebSocketConnected = false;
  private pendingRequests = new Map<number, PendingRequest>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(options: JsonRpcProviderOptions) {
    super(options);
    this.httpUrl = options.httpUrl;
    this.wsUrl = options.wsUrl;
    this.timeout = options.timeout || 30000;

    this.network = options.network;

    // Initialize rate limiter
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  get connectionOptions() {
    return {
      type: this.type,
      uniqName: this.uniqName,
      httpUrl: this.httpUrl,
      wsUrl: this.wsUrl,
      timeout: this.timeout,
      network: this.network,
      rateLimits: this.rateLimiter.getStats().config,
    };
  }

  get wsClient() {
    return this._wsClient;
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this.rateLimiter.executeRequest(() => this.jsonRpcCall('eth_blockNumber', []));
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
      // Try a simple JSON-RPC call through WebSocket
      await this.wsJsonRpcCall('eth_blockNumber', []);
      return true;
    } catch (error) {
      this.isWebSocketConnected = false;
      return false;
    }
  }

  public async connect(): Promise<void> {
    const health = await this.healthcheck();
    if (!health) {
      throw new Error('Cannot connect to the JSON-RPC node');
    }

    // Validate chainId after connection
    try {
      const connectedChainId = await this.jsonRpcCall('eth_chainId', []);
      const expectedChainId = this.network.chainId;
      const parsedChainId = parseInt(connectedChainId, 16);

      if (parsedChainId !== expectedChainId) {
        throw new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${parsedChainId}`);
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
    this.isWebSocketConnected = false;

    // Clear all pending requests
    this.pendingRequests.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(new Error('Connection closed'));
    });
    this.pendingRequests.clear();

    if (this._wsClient) {
      try {
        this._wsClient.close(1000, 'Client disconnecting');
      } catch (error) {
        // Ignore disconnection errors
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
        this._wsClient.close(1000, 'Reconnecting');
      } catch (error) {
        // Ignore disconnection errors
      }
      this._wsClient = undefined;
      this.isWebSocketConnected = false;
    }

    // Establish new WebSocket connection
    if (this.wsUrl) {
      await this.connectWebSocket();
    }
  }

  /* eslint-disable no-empty */
  private async connectWebSocket(): Promise<void> {
    if (!this.wsUrl) {
      throw new Error('WebSocket URL not provided');
    }

    return new Promise<void>((resolve, reject) => {
      try {
        this._wsClient = new WebSocket(this.wsUrl!);

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        const handleOpen = async () => {
          try {
            // Validate chainId after WebSocket connection
            const connectedChainId = await this.wsJsonRpcCall('eth_chainId', []);
            const expectedChainId = this.network.chainId;
            const parsedChainId = parseInt(connectedChainId, 16);

            if (parsedChainId !== expectedChainId) {
              this.isWebSocketConnected = false;
              clearTimeout(timeout);
              cleanup();
              reject(new Error(`Chain ID mismatch: expected ${expectedChainId}, got ${parsedChainId}`));
              return;
            }

            this.isWebSocketConnected = true;
            this.reconnectAttempts = 0;
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

          // Reject all pending requests
          this.pendingRequests.forEach((request) => {
            clearTimeout(request.timeout);
            request.reject(new Error('WebSocket connection closed'));
          });
          this.pendingRequests.clear();

          // Auto-reconnect logic (handled by ConnectionManager)
        };

        const handleMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);

            if (Array.isArray(data)) {
              // Batch response
              data.forEach((response) => this.handleSingleResponse(response));
            } else {
              // Single response
              this.handleSingleResponse(data);
            }
          } catch (error) {}
        };

        const cleanup = () => {
          this._wsClient?.removeEventListener('open', handleOpen);
          this._wsClient?.removeEventListener('error', handleError);
          this._wsClient?.removeEventListener('close', handleClose);
          this._wsClient?.removeEventListener('message', handleMessage);
        };

        this._wsClient.addEventListener('open', handleOpen);
        this._wsClient.addEventListener('error', handleError);
        this._wsClient.addEventListener('close', handleClose);
        this._wsClient.addEventListener('message', handleMessage);
      } catch (error) {
        this.isWebSocketConnected = false;
        reject(error);
      }
    });
  }
  /* eslint-enable no-empty */

  private handleSingleResponse(response: any) {
    const requestId = response.id;
    const pendingRequest = this.pendingRequests.get(requestId);

    if (pendingRequest) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pendingRequest.timeout);

      if (response.error) {
        pendingRequest.reject(new Error(`JSON-RPC Error ${response.error.code}: ${response.error.message}`));
      } else {
        pendingRequest.resolve(response.result);
      }
    }
  }

  /**
   * Makes a JSON-RPC call - automatically chooses WebSocket or HTTP
   */

  private async jsonRpcCall(method: string, params: any[]): Promise<any> {
    // Use WebSocket if available and connected
    if (this.isWebSocketConnected && this._wsClient) {
      try {
        return await this.wsJsonRpcCall(method, params);
      } catch (error) {
        // Intentionally ignored, fallback to HTTP
      }
    }

    // Fallback to HTTP
    return await this.httpJsonRpcCall(method, params);
  }

  /**
   * Makes a batch JSON-RPC call - automatically chooses WebSocket or HTTP
   */

  private async jsonRpcBatchCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    // Use WebSocket if available and connected
    if (this.isWebSocketConnected && this._wsClient) {
      try {
        return await this.wsJsonRpcBatchCall(calls);
      } catch (error) {
        // Intentionally ignored, fallback to HTTP
      }
    }

    // Fallback to HTTP
    return await this.httpJsonRpcBatchCall(calls);
  }

  /**
   * Makes a single JSON-RPC call via WebSocket
   */
  private async wsJsonRpcCall(method: string, params: any[]): Promise<any> {
    if (!this.isWebSocketConnected || !this._wsClient) {
      throw new Error('WebSocket not connected');
    }

    const id = this.requestId++;
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`WebSocket request timeout for ${method}`));
      }, this.timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this._wsClient!.send(JSON.stringify(payload));
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Makes a batch JSON-RPC call via WebSocket
   */
  private async wsJsonRpcBatchCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    if (!this.isWebSocketConnected || !this._wsClient) {
      throw new Error('WebSocket not connected');
    }

    const payload = calls.map((call) => ({
      jsonrpc: '2.0',
      method: call.method,
      params: call.params,
      id: this.requestId++,
    }));

    const requestIds = payload.map((p) => p.id);

    return new Promise<any[]>((resolve, reject) => {
      const responses: any[] = new Array(payload.length);
      let receivedCount = 0;

      const cleanup = () => {
        requestIds.forEach((id) => {
          const pendingRequest = this.pendingRequests.get(id);
          if (pendingRequest) {
            this.pendingRequests.delete(id);
            clearTimeout(pendingRequest.timeout);
          }
        });
      };

      const batchTimeout = setTimeout(() => {
        cleanup();
        reject(new Error(`WebSocket batch request timeout`));
      }, this.timeout);

      // Set up individual request handlers
      requestIds.forEach((id, index) => {
        this.pendingRequests.set(id, {
          resolve: (result) => {
            responses[index] = result;
            receivedCount++;

            if (receivedCount === payload.length) {
              clearTimeout(batchTimeout);
              cleanup();
              resolve(responses);
            }
          },
          reject: (error) => {
            clearTimeout(batchTimeout);
            cleanup();
            reject(error);
          },
          timeout: batchTimeout, // We use the batch timeout for all
        });
      });

      try {
        this._wsClient!.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(batchTimeout);
        cleanup();
        reject(error);
      }
    });
  }

  /**
   * Makes a single JSON-RPC call via HTTP
   */
  private async httpJsonRpcCall(method: string, params: any[]): Promise<any> {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.requestId++,
    };

    const response = await fetch(this.httpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
    }

    return result.result;
  }

  /**
   * Makes a batch JSON-RPC call via HTTP
   */
  private async httpJsonRpcBatchCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
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
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const results = await response.json();

    return results.map((result: any) => {
      if (result.error) {
        throw new Error(`JSON-RPC Error ${result.error.code}: ${result.error.message}`);
      }
      return result.result;
    });
  }

  // ===== BLOCK METHODS =====

  public async getBlockHeight(): Promise<number> {
    const blockNumber = await this.rateLimiter.executeRequest(() => this.jsonRpcCall('eth_blockNumber', []));
    return parseInt(blockNumber, 16);
  }

  public async getOneBlockByHeight(blockNumber: number, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const blockHex = `0x${blockNumber.toString(16)}`;
    const rawBlock = await this.rateLimiter.executeRequest(() =>
      this.jsonRpcCall('eth_getBlockByNumber', [blockHex, fullTransactions])
    );

    if (!rawBlock) {
      throw new Error(`Block ${blockNumber} not found`);
    }

    return this.normalizeRawBlock(rawBlock);
  }

  public async getOneBlockHashByHeight(height: number): Promise<string> {
    const blockHex = `0x${height.toString(16)}`;
    const rawBlock = await this.rateLimiter.executeRequest(() =>
      this.jsonRpcCall('eth_getBlockByNumber', [blockHex, false])
    );

    if (!rawBlock) {
      throw new Error(`Block ${height} not found`);
    }

    return rawBlock.hash;
  }

  public async getOneBlockByHash(hash: Hash, fullTransactions: boolean = false): Promise<UniversalBlock> {
    const rawBlock = await this.rateLimiter.executeRequest(() =>
      this.jsonRpcCall('eth_getBlockByHash', [hash, fullTransactions])
    );

    if (!rawBlock) {
      throw new Error(`Block ${hash} not found`);
    }

    return this.normalizeRawBlock(rawBlock);
  }

  public async getManyBlocksByHashes(hashes: string[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    if (hashes.length === 0) {
      return [];
    }

    // Create batch function for JSON-RPC batch calls
    const batchRequestFn = async (batchHashes: string[]): Promise<UniversalBlock[]> => {
      const calls = batchHashes.map((hash) => ({
        method: 'eth_getBlockByHash',
        params: [hash, fullTransactions],
      }));

      // One request (WebSocket or HTTP) with batch JSON-RPC calls
      const rawBlocks = await this.jsonRpcBatchCall(calls);

      return rawBlocks.filter((block) => block !== null).map((block) => this.normalizeRawBlock(block));
    };

    // Use rate limiter for batch requests
    return await this.rateLimiter.executeBatchRequests(hashes, batchRequestFn);
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    if (heights.length === 0) {
      return [];
    }

    // Create batch function for JSON-RPC batch calls
    const batchRequestFn = async (batchHeights: number[]): Promise<UniversalBlock[]> => {
      const calls = batchHeights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, fullTransactions],
      }));

      // One request (WebSocket or HTTP) with batch JSON-RPC calls
      const rawBlocks = await this.jsonRpcBatchCall(calls);

      return rawBlocks.filter((block) => block !== null).map((block) => this.normalizeRawBlock(block));
    };

    // Use rate limiter for batch requests
    return await this.rateLimiter.executeBatchRequests(heights, batchRequestFn);
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    if (heights.length === 0) {
      return [];
    }

    // Create batch function for JSON-RPC batch calls
    const batchRequestFn = async (batchHeights: number[]): Promise<any[]> => {
      const calls = batchHeights.map((height) => ({
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, false],
      }));

      const rawBlocks = await this.jsonRpcBatchCall(calls);

      return rawBlocks
        .filter((block) => block !== null)
        .map((block: any) => ({
          number: parseInt(block.number || block.blockNumber, 16),
          hash: block.hash,
          size: parseInt(block.size, 16),
        }));
    };

    return await this.rateLimiter.executeBatchRequests(heights, batchRequestFn);
  }

  // ===== TRANSACTION METHODS =====

  public async getOneTransactionByHash(hash: Hash): Promise<UniversalTransaction> {
    const rawTx = await this.rateLimiter.executeRequest(() => this.jsonRpcCall('eth_getTransactionByHash', [hash]));

    if (!rawTx) {
      throw new Error(`Transaction ${hash} not found`);
    }

    return this.normalizeRawTransaction(rawTx);
  }

  public async getManyTransactionsByHashes(hashes: Hash[]): Promise<UniversalTransaction[]> {
    if (hashes.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHashes: string[]): Promise<UniversalTransaction[]> => {
      const calls = batchHashes.map((hash) => ({
        method: 'eth_getTransactionByHash',
        params: [hash],
      }));

      const rawTransactions = await this.jsonRpcBatchCall(calls);

      return rawTransactions.filter((tx) => tx !== null).map((tx) => this.normalizeRawTransaction(tx));
    };

    return await this.rateLimiter.executeBatchRequests(hashes, batchRequestFn);
  }

  public async getTransactionReceipt(hash: Hash): Promise<UniversalTransactionReceipt> {
    const rawReceipt = await this.rateLimiter.executeRequest(() =>
      this.jsonRpcCall('eth_getTransactionReceipt', [hash])
    );

    if (!rawReceipt) {
      throw new Error(`Transaction receipt ${hash} not found`);
    }

    return this.normalizeRawReceipt(rawReceipt);
  }

  public async getManyTransactionReceipts(hashes: Hash[]): Promise<UniversalTransactionReceipt[]> {
    if (hashes.length === 0) {
      return [];
    }

    const batchRequestFn = async (batchHashes: string[]): Promise<UniversalTransactionReceipt[]> => {
      const calls = batchHashes.map((hash) => ({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      }));

      const rawReceipts = await this.jsonRpcBatchCall(calls);

      return rawReceipts.filter((receipt) => receipt !== null).map((receipt) => this.normalizeRawReceipt(receipt));
    };

    return await this.rateLimiter.executeBatchRequests(hashes, batchRequestFn);
  }

  // ===== NORMALIZATION METHODS =====

  /**
   * Normalizes raw JSON-RPC block response to UniversalBlock format
   * Handles hex string conversion and different provider field naming
   */
  private normalizeRawBlock(rawBlock: any): UniversalBlock {
    return {
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,

      // Handle different provider naming for block number
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

      // Keep hex strings as-is for difficulty
      difficulty: rawBlock.difficulty,
      totalDifficulty: rawBlock.totalDifficulty,

      extraData: rawBlock.extraData,

      // Convert hex strings to numbers
      size: parseInt(rawBlock.size, 16),
      gasLimit: parseInt(rawBlock.gasLimit, 16),
      gasUsed: parseInt(rawBlock.gasUsed, 16),
      timestamp: parseInt(rawBlock.timestamp, 16),

      uncles: rawBlock.uncles || [],

      // EIP-1559 fields - keep as hex strings
      baseFeePerGas: rawBlock.baseFeePerGas,

      // Shanghai fork fields
      withdrawals: rawBlock.withdrawals,
      withdrawalsRoot: rawBlock.withdrawalsRoot,

      // Cancun fork fields - keep as hex strings
      blobGasUsed: rawBlock.blobGasUsed,
      excessBlobGas: rawBlock.excessBlobGas,
      parentBeaconBlockRoot: rawBlock.parentBeaconBlockRoot,

      // Handle transactions - could be hashes or full objects
      transactions: rawBlock.transactions?.map((tx: any) =>
        typeof tx === 'string' ? tx : this.normalizeRawTransaction(tx)
      ),
    };
  }

  /**
   * Normalizes raw JSON-RPC transaction response to UniversalTransaction format
   * Handles hex string parsing and ensures all fields are properly formatted
   */
  private normalizeRawTransaction(rawTx: any): UniversalTransaction {
    // Helper function to safely parse hex values
    const parseHexSafely = (value: string | undefined, fieldName: string): number => {
      if (!value) return 0;
      const parsed = parseInt(value, 16);
      if (isNaN(parsed)) {
        throw new Error(`Invalid hex value for ${fieldName}: ${value}`);
      }
      return parsed;
    };

    // Helper function for optional hex parsing
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

      // Keep value as hex string
      value: rawTx.value,

      gas: parseHexSafely(rawTx.gas, 'gas'),
      input: rawTx.input,
      blockHash: rawTx.blockHash,

      // Parse hex block number and transaction index
      blockNumber: parseHexOptional(rawTx.blockNumber),
      transactionIndex: parseHexOptional(rawTx.transactionIndex),

      // Keep gas price as hex string
      gasPrice: rawTx.gasPrice,

      // Parse hex chain ID
      chainId: rawTx.chainId ? parseHexSafely(rawTx.chainId, 'chainId') : undefined,

      // Signature fields
      v: rawTx.v,
      r: rawTx.r,
      s: rawTx.s,

      // Transaction type - default to legacy if not specified
      type: rawTx.type || '0x0',

      // EIP-1559 fields - keep as hex strings
      maxFeePerGas: rawTx.maxFeePerGas,
      maxPriorityFeePerGas: rawTx.maxPriorityFeePerGas,

      // EIP-2930 access list
      accessList: rawTx.accessList,

      // EIP-4844 blob transaction fields
      maxFeePerBlobGas: rawTx.maxFeePerBlobGas,
      blobVersionedHashes: rawTx.blobVersionedHashes,
    };
  }

  /**
   * Normalizes raw JSON-RPC receipt response to UniversalTransactionReceipt
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
      logs: rawReceipt.logs?.map((log: any) => this.normalizeRawLog(log)) || [],
      logsBloom: rawReceipt.logsBloom,
      status: rawReceipt.status === '0x1' ? '0x1' : '0x0',
      type: rawReceipt.type || '0x0',
      effectiveGasPrice: rawReceipt.effectiveGasPrice ? parseInt(rawReceipt.effectiveGasPrice, 16) : 0,
      blobGasUsed: rawReceipt.blobGasUsed,
      blobGasPrice: rawReceipt.blobGasPrice,
    };
  }

  /**
   * Normalizes raw JSON-RPC log to UniversalLog
   */
  private normalizeRawLog(rawLog: any): UniversalLog {
    return {
      address: rawLog.address,
      topics: rawLog.topics,
      data: rawLog.data,
      blockNumber: rawLog.blockNumber ? parseInt(rawLog.blockNumber, 16) : null,
      transactionHash: rawLog.transactionHash,
      transactionIndex: rawLog.transactionIndex ? parseInt(rawLog.transactionIndex, 16) : null,
      blockHash: rawLog.blockHash,
      logIndex: rawLog.logIndex ? parseInt(rawLog.logIndex, 16) : null,
      removed: rawLog.removed || false,
    };
  }
}
