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
  }

  public async disconnect(): Promise<void> {
    // JSON-RPC over HTTP doesn't maintain persistent connections
    // WebSocket implementation would go here if needed
  }

  /**
   * Makes a JSON-RPC call to the node
   */
  private async jsonRpcCall(method: string, params: any[]): Promise<any> {
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
   * Makes a batch JSON-RPC call
   */
  private async jsonRpcBatchCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
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
    const calls = hashes.map((hash) => ({
      method: 'eth_getBlockByHash',
      params: [hash, fullTransactions],
    }));

    const rawBlocks = await this.rateLimiter.executeRequest(() => this.jsonRpcBatchCall(calls));

    return rawBlocks.filter((block) => block !== null).map((block) => this.normalizeRawBlock(block));
  }

  public async getManyBlocksByHeights(heights: number[], fullTransactions: boolean = false): Promise<UniversalBlock[]> {
    const calls = heights.map((height) => ({
      method: 'eth_getBlockByNumber',
      params: [`0x${height.toString(16)}`, fullTransactions],
    }));

    const rawBlocks = await this.rateLimiter.executeRequest(() => this.jsonRpcBatchCall(calls));

    return rawBlocks.filter((block) => block !== null).map((block) => this.normalizeRawBlock(block));
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<any[]> {
    const calls = heights.map((height) => ({
      method: 'eth_getBlockByNumber',
      params: [`0x${height.toString(16)}`, false],
    }));

    const rawBlocks = await this.rateLimiter.executeRequest(() => this.jsonRpcBatchCall(calls));

    return rawBlocks
      .filter((block) => block !== null)
      .map((block: any) => ({
        number: parseInt(block.number || block.blockNumber, 16),
        hash: block.hash,
        size: parseInt(block.size, 16),
      }));
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
    const calls = hashes.map((hash) => ({
      method: 'eth_getTransactionByHash',
      params: [hash],
    }));

    const rawTransactions = await this.rateLimiter.executeRequest(() => this.jsonRpcBatchCall(calls));

    return rawTransactions.filter((tx) => tx !== null).map((tx) => this.normalizeRawTransaction(tx));
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
    const calls = hashes.map((hash) => ({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    }));

    const rawReceipts = await this.rateLimiter.executeRequest(() => this.jsonRpcBatchCall(calls));

    return rawReceipts.filter((receipt) => receipt !== null).map((receipt) => this.normalizeRawReceipt(receipt));
  }

  // ===== NORMALIZATION METHODS =====

  /**
   * Normalizes raw JSON-RPC block response to UniversalBlock
   */
  private normalizeRawBlock(rawBlock: any): UniversalBlock {
    return {
      hash: rawBlock.hash,
      parentHash: rawBlock.parentHash,
      // Handle different provider naming for block number (QuickNode vs others)
      blockNumber: rawBlock.blockNumber ? parseInt(rawBlock.blockNumber, 16) : undefined,
      number: rawBlock.number ? parseInt(rawBlock.number, 16) : undefined,
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

      // Optional EIP-1559 fields
      baseFeePerGas: rawBlock.baseFeePerGas,

      // Optional Shanghai fork fields
      withdrawals: rawBlock.withdrawals,
      withdrawalsRoot: rawBlock.withdrawalsRoot,

      // Optional Cancun fork fields
      blobGasUsed: rawBlock.blobGasUsed,
      excessBlobGas: rawBlock.excessBlobGas,
      parentBeaconBlockRoot: rawBlock.parentBeaconBlockRoot,

      // Handle transactions
      transactions: rawBlock.transactions?.map((tx: any) =>
        typeof tx === 'string' ? tx : this.normalizeRawTransaction(tx)
      ),
    };
  }

  /**
   * Normalizes raw JSON-RPC transaction response to UniversalTransaction
   */
  private normalizeRawTransaction(rawTx: any): UniversalTransaction {
    return {
      hash: rawTx.hash,
      nonce: parseInt(rawTx.nonce, 16),
      from: rawTx.from,
      to: rawTx.to,
      value: rawTx.value,
      gas: parseInt(rawTx.gas, 16),
      input: rawTx.input,
      blockHash: rawTx.blockHash,
      blockNumber: rawTx.blockNumber ? parseInt(rawTx.blockNumber, 16) : null,
      transactionIndex: rawTx.transactionIndex ? parseInt(rawTx.transactionIndex, 16) : null,

      // Gas pricing
      gasPrice: rawTx.gasPrice,

      // Signature fields
      chainId: rawTx.chainId ? parseInt(rawTx.chainId, 16) : undefined,
      v: rawTx.v,
      r: rawTx.r,
      s: rawTx.s,

      // Transaction type and EIP-1559 fields
      type: rawTx.type || '0x0',
      maxFeePerGas: rawTx.maxFeePerGas,
      maxPriorityFeePerGas: rawTx.maxPriorityFeePerGas,

      // EIP-2930 access list
      accessList: rawTx.accessList,

      // EIP-4844 blob fields
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
