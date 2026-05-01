import * as Web3Module from 'web3';
const Web3 = (Web3Module as any).default ?? Web3Module;
import type { BaseNodeProviderOptions } from './base.provider';
import { BaseNodeProvider } from './base.provider';
import { NodeProviderTypes } from './interfaces';
import { RateLimiter } from '../transports/rate-limiter';
import { EvmTrieVerifier } from './trie-verifier';
import {
  quantityToDecimalString,
  quantityToNumber,
  optionalQuantityToNumber,
  normalizeHex,
  normalizeAddress,
} from '../value-normalization';
import type {
  UniversalBlockStats,
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalTrace,
  NetworkConfig,
  Hash,
} from './interfaces';

export interface Web3jsProviderOptions extends BaseNodeProviderOptions {
  httpUrl: string;
  wsUrl?: string;
  network: NetworkConfig;
  responseTimeout?: number;
}

export const createWeb3jsProvider = (options: Web3jsProviderOptions): Web3jsProvider => new Web3jsProvider(options);

export class Web3jsProvider extends BaseNodeProvider<Web3jsProviderOptions> {
  readonly type = NodeProviderTypes.WEB3JS;
  private httpUrl: string;
  private wsUrl?: string;
  private network: NetworkConfig;
  private rateLimiter: RateLimiter;
  private requestId = 1;
  private responseTimeout: number;

  constructor(options: Web3jsProviderOptions) {
    super(options);
    this.httpUrl = new URL(options.httpUrl).toString();
    this.wsUrl = options.wsUrl;
    this.network = options.network;
    this.responseTimeout = options.responseTimeout ?? 5000;
    this._hasWebSocketUrl = !!this.wsUrl;

    const httpProviderOptions = {
      timeout: this.responseTimeout,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
    };
    this._httpClient = new Web3(new Web3.providers.HttpProvider(this.httpUrl, httpProviderOptions));
    if (this.wsUrl) this.initializeWebSocket();
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  get connectionOptions(): Web3jsProviderOptions {
    return {
      type: this.type,
      uniqName: this.uniqName,
      httpUrl: this.httpUrl,
      wsUrl: this.wsUrl,
      network: this.network,
      rateLimits: this.rateLimits,
    } as any;
  }

  private initializeWebSocket(): void {
    if (!this.wsUrl) return;
    try {
      const wsProvider = new Web3.providers.WebsocketProvider(this.wsUrl);
      this._wsClient = new Web3(wsProvider);
      wsProvider.on('connect', () => {
        this._isWebSocketConnected = true;
      });
      wsProvider.on('close', () => {
        this._isWebSocketConnected = false;
      });
      wsProvider.on('error', () => {
        this._isWebSocketConnected = false;
      });
    } catch {
      this._isWebSocketConnected = false;
    }
  }

  healthcheckWebSocket(): boolean {
    return this._hasWebSocketUrl && this._isWebSocketConnected && !!this._wsClient;
  }

  async handleConnectionError(error: any, _: string): Promise<void> {
    throw error;
  }

  public async healthcheck(): Promise<boolean> {
    try {
      await this._httpClient.eth.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  public async connect(): Promise<void> {
    if (!(await this.healthcheck())) throw new Error('Cannot connect to the node');
    try {
      const chainId = await this._httpClient.eth.getChainId();
      if (Number(chainId) !== this.network.chainId) {
        throw new Error(`Chain ID mismatch: expected ${this.network.chainId}, got ${chainId}`);
      }
    } catch (e) {
      throw new Error(`Chain validation failed: ${e}`);
    }
    if (this._hasWebSocketUrl && !this._wsClient) this.initializeWebSocket();
  }

  public async disconnect(): Promise<void> {
    await this.rateLimiter.stop();
    if (this._wsClient) {
      const provider = this._wsClient.currentProvider;
      if (provider?.disconnect) provider.disconnect();
      this._wsClient = undefined;
      this._isWebSocketConnected = false;
    }
  }

  public async reconnectWebSocket(): Promise<void> {
    if (!this.wsUrl) throw new Error('No WebSocket URL');
    if (this._wsClient) {
      const p = this._wsClient.currentProvider;
      if (p?.disconnect) p.disconnect();
      this._wsClient = undefined;
      this._isWebSocketConnected = false;
    }
    this.initializeWebSocket();
    await new Promise((r) => setTimeout(r, 1000));
    if (!this.healthcheckWebSocket()) throw new Error('WebSocket reconnect failed');
  }

  private async _batchRpcCall(calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    const payload = calls.map((c) => ({ jsonrpc: '2.0', method: c.method, params: c.params, id: this.requestId++ }));
    const response = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.responseTimeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json();
    return (Array.isArray(results) ? results : [results]).map((r: any) => {
      if (!r) return null;
      if (r.error) throw new Error(`RPC Error: ${r.error.message}`);
      return r.result;
    });
  }

  private get batchCall() {
    return (calls: any) => this._batchRpcCall(calls);
  }

  private async executeWithErrorHandling<T>(op: () => Promise<T>, method: string): Promise<T> {
    try {
      return await op();
    } catch (e) {
      await this.handleConnectionError(e, method);
      throw e;
    }
  }

  public subscribeToNewBlocks(callback: (blockNumber: number) => void): { unsubscribe(): void } {
    if (!this._wsClient || !this.healthcheckWebSocket()) throw new Error('WebSocket not available');
    const sub = this._wsClient.eth.subscribe('newBlockHeaders');
    sub.on('data', (header: any) => callback(Number(header.number)));
    return { unsubscribe: () => sub.unsubscribe() };
  }

  public async getBlockHeight(): Promise<number> {
    const results = await this.rateLimiter.execute([{ method: 'eth_blockNumber', params: [] }], this.batchCall);
    return parseInt(results[0], 16);
  }

  public async getManyBlocksByHeights(
    heights: number[],
    fullTransactions = false,
    verifyTrie = false
  ): Promise<(UniversalBlock | null)[]> {
    if (!heights.length) return [];
    const requests = heights.map((h) => ({
      method: 'eth_getBlockByNumber',
      params: [`0x${h.toString(16)}`, fullTransactions],
    }));
    const rawBlocks = await this.rateLimiter.execute(requests, this.batchCall);
    return Promise.all(
      rawBlocks.map(async (b, i) => {
        if (!b) return null;
        if (verifyTrie && fullTransactions && b.transactions?.length && b.transactionsRoot) {
          const valid = await EvmTrieVerifier.verifyTransactionsRoot(b.transactions, b.transactionsRoot);
          if (!valid) throw new Error(`Tx root mismatch block ${heights[i]}`);
        }
        const nb = this.normalizeRawBlock(b);
        if (nb.blockNumber == null) nb.blockNumber = heights[i];
        return nb;
      })
    );
  }

  public async getManyBlocksByHashes(hashes: Hash[], fullTransactions = false): Promise<(UniversalBlock | null)[]> {
    if (!hashes.length) return [];
    const requests = hashes.map((h) => ({ method: 'eth_getBlockByHash', params: [h, fullTransactions] }));
    const rawBlocks = await this.rateLimiter.execute(requests, this.batchCall);
    return rawBlocks.map((b) => (b ? this.normalizeRawBlock(b) : null));
  }

  public async getManyBlocksStatsByHeights(heights: number[]): Promise<(UniversalBlockStats | null)[]> {
    if (!heights.length) return [];
    const requests = heights.map((h) => ({ method: 'eth_getBlockByNumber', params: [`0x${h.toString(16)}`, false] }));
    const rawBlocks = await this.rateLimiter.execute(requests, this.batchCall);
    return rawBlocks.map((b, i) => {
      if (!b) return null;
      const stats = this.normalizeBlockStats(b);
      if (!stats.number) stats.number = heights[i]!;
      return stats;
    });
  }

  public async getManyBlocksWithReceipts(
    heights: string[] | number[],
    fullTransactions = false,
    verifyTrie = false
  ): Promise<(UniversalBlock | null)[]> {
    if (!heights.length) return [];
    return this.executeWithErrorHandling(async () => {
      const numeric = heights.map(Number);
      const rawBlocks = await this.getManyBlocksByHeights(numeric, fullTransactions, verifyTrie && fullTransactions);
      const receiptsRoots = verifyTrie ? rawBlocks.map((b) => b?.receiptsRoot) : undefined;
      const allReceipts = await this.getManyBlocksReceipts(numeric, rawBlocks, verifyTrie, receiptsRoots);
      return rawBlocks.map((rawBlock, i) => {
        if (!rawBlock) return null;
        return { ...rawBlock, receipts: allReceipts[i] || [] };
      });
    }, 'getManyBlocksWithReceipts');
  }

  private async getManyBlocksReceipts(
    heights: number[],
    blocks: Array<UniversalBlock | null>,
    verifyTrie = false,
    receiptsRoots?: (string | undefined)[]
  ): Promise<UniversalTransactionReceipt[][]> {
    if (!heights.length) return [];

    const strategy = this.network.receiptsStrategy ?? 'auto';

    if (strategy === 'block-receipts' || strategy === 'auto') {
      try {
        return await this.getManyBlocksReceiptsViaBlockRpc(heights, verifyTrie, receiptsRoots);
      } catch (error) {
        if (strategy === 'block-receipts') throw error;
      }
    }

    return this.getManyBlocksReceiptsViaTransactions(heights, blocks, verifyTrie, receiptsRoots);
  }

  private async getManyBlocksReceiptsViaBlockRpc(
    heights: number[],
    verifyTrie = false,
    receiptsRoots?: (string | undefined)[]
  ): Promise<UniversalTransactionReceipt[][]> {
    const requests = heights.map((h) => ({ method: 'eth_getBlockReceipts', params: [`0x${h.toString(16)}`] }));
    const rawAll = await this.rateLimiter.execute(requests, this.batchCall);

    return Promise.all(
      rawAll.map(async (rawReceipts, i) => {
        if (!rawReceipts || !Array.isArray(rawReceipts)) return [];
        if (verifyTrie && receiptsRoots?.[i]) {
          const valid = await EvmTrieVerifier.verifyReceiptsRoot(rawReceipts, receiptsRoots[i]!);
          if (!valid) throw new Error(`Receipts root mismatch for block ${heights[i]}`);
        }
        return rawReceipts.map((r) => this.normalizeRawReceiptForHeight(r, heights[i]!));
      })
    );
  }

  private async getManyBlocksReceiptsViaTransactions(
    heights: number[],
    blocks: Array<UniversalBlock | null>,
    verifyTrie = false,
    receiptsRoots?: (string | undefined)[]
  ): Promise<UniversalTransactionReceipt[][]> {
    return Promise.all(
      blocks.map(async (block, i) => {
        if (!block) return [];
        const hashes = (block.transactions ?? [])
          .map((tx: UniversalTransaction | string) => (typeof tx === 'string' ? tx : tx.hash))
          .filter(Boolean);

        if (hashes.length === 0) return [];

        const requests = hashes.map((hash) => ({ method: 'eth_getTransactionReceipt', params: [hash] }));
        const rawReceipts = await this.rateLimiter.execute(requests, this.batchCall);
        const receipts = rawReceipts
          .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null)
          .map((receipt) => this.normalizeRawReceiptForHeight(receipt, heights[i]!));

        if (verifyTrie && receiptsRoots?.[i]) {
          const valid = await EvmTrieVerifier.verifyReceiptsRoot(rawReceipts.filter(Boolean), receiptsRoots[i]!);
          if (!valid) throw new Error(`Receipts root mismatch for block ${heights[i]}`);
        }

        return receipts;
      })
    );
  }

  private normalizeRawReceiptForHeight(raw: any, fallbackHeight: number): UniversalTransactionReceipt {
    const receipt = this.normalizeRawReceipt(raw);
    if (receipt.blockNumber == null) receipt.blockNumber = fallbackHeight;
    return receipt;
  }

  public async assertTraceSupport(): Promise<void> {
    const height = await this.getBlockHeight();
    const hexHeight = `0x${height.toString(16)}`;
    const strategy = this.network.traceStrategy ?? 'auto';
    const errors: string[] = [];

    if (strategy === 'debug-trace' || strategy === 'auto') {
      try {
        await this._batchRpcCall([
          { method: 'debug_traceBlockByNumber', params: [hexHeight, { tracer: 'callTracer' }] },
        ]);
        return;
      } catch (e) {
        errors.push(`debug_traceBlockByNumber: ${(e as Error)?.message ?? String(e)}`);
        if (strategy === 'debug-trace')
          throw new Error(`Trace API debug-trace is not supported by provider ${this.uniqName}: ${errors.join(' | ')}`);
      }
    }

    if (strategy === 'parity-trace' || strategy === 'auto') {
      try {
        await this._batchRpcCall([{ method: 'trace_block', params: [hexHeight] }]);
        return;
      } catch (e) {
        errors.push(`trace_block: ${(e as Error)?.message ?? String(e)}`);
        if (strategy === 'parity-trace')
          throw new Error(
            `Trace API parity-trace is not supported by provider ${this.uniqName}: ${errors.join(' | ')}`
          );
      }
    }

    throw new Error(`Trace API is not supported by provider ${this.uniqName}: ${errors.join(' | ')}`);
  }

  // ===== TRACE METHODS =====

  public async getTracesByBlockNumber(blockNumber: number): Promise<UniversalTrace[]> {
    const hexHeight = `0x${blockNumber.toString(16)}`;
    const strategy = this.network.traceStrategy ?? 'auto';
    const errors: string[] = [];

    if (strategy === 'debug-trace' || strategy === 'auto') {
      try {
        const results = await this._batchRpcCall([
          {
            method: 'debug_traceBlockByNumber',
            params: [hexHeight, { tracer: 'callTracer' }],
          },
        ]);
        if (results[0] && Array.isArray(results[0])) {
          return results[0].map((t: any) => this.normalizeGethTrace(t, blockNumber));
        }
      } catch (e) {
        errors.push(`debug_traceBlockByNumber: ${(e as Error)?.message ?? String(e)}`);
        if (strategy === 'debug-trace')
          throw new Error(
            `Trace API debug-trace is not supported by provider ${this.uniqName} for block ${blockNumber}: ${errors.join(' | ')}`
          );
      }
    }

    if (strategy === 'parity-trace' || strategy === 'auto') {
      try {
        const results = await this._batchRpcCall([{ method: 'trace_block', params: [hexHeight] }]);
        if (results[0] && Array.isArray(results[0])) {
          return results[0].map((t: any) => this.normalizeParityTrace(t));
        }
      } catch (e) {
        errors.push(`trace_block: ${(e as Error)?.message ?? String(e)}`);
        if (strategy === 'parity-trace')
          throw new Error(
            `Trace API parity-trace is not supported by provider ${this.uniqName} for block ${blockNumber}: ${errors.join(' | ')}`
          );
      }
    }

    throw new Error(
      `Trace API is not supported by provider ${this.uniqName} for block ${blockNumber}: ${errors.join(' | ')}`
    );
  }

  public async getTracesByTxHash(hash: string): Promise<UniversalTrace[]> {
    const strategy = this.network.traceStrategy ?? 'auto';
    const errors: string[] = [];

    if (strategy === 'debug-trace' || strategy === 'auto') {
      try {
        const results = await this._batchRpcCall([
          {
            method: 'debug_traceTransaction',
            params: [hash, { tracer: 'callTracer' }],
          },
        ]);
        if (results[0]) return [this.normalizeGethTrace(results[0], undefined, hash)];
      } catch (e) {
        errors.push(`debug_traceTransaction: ${(e as Error)?.message ?? String(e)}`);
        if (strategy === 'debug-trace')
          throw new Error(
            `Trace API debug-trace is not supported by provider ${this.uniqName} for transaction ${hash}: ${errors.join(' | ')}`
          );
      }
    }

    if (strategy === 'parity-trace' || strategy === 'auto') {
      try {
        const results = await this._batchRpcCall([{ method: 'trace_transaction', params: [hash] }]);
        if (results[0] && Array.isArray(results[0])) {
          return results[0].map((t: any) => this.normalizeParityTrace(t));
        }
      } catch (e) {
        errors.push(`trace_transaction: ${(e as Error)?.message ?? String(e)}`);
        if (strategy === 'parity-trace')
          throw new Error(
            `Trace API parity-trace is not supported by provider ${this.uniqName} for transaction ${hash}: ${errors.join(' | ')}`
          );
      }
    }

    throw new Error(
      `Trace API is not supported by provider ${this.uniqName} for transaction ${hash}: ${errors.join(' | ')}`
    );
  }

  // ===== MEMPOOL METHODS =====

  public subscribeToPendingTransactions(callback: (txHash: string) => void): { unsubscribe(): void } {
    if (!this._wsClient || !this.healthcheckWebSocket()) throw new Error('WebSocket not available');
    const sub = this._wsClient.eth.subscribe('pendingTransactions');
    sub.on('data', (hash: string) => callback(hash));
    return { unsubscribe: () => sub.unsubscribe() };
  }

  public async getRawMempool(): Promise<Record<string, any>> {
    try {
      const r = await this._batchRpcCall([{ method: 'txpool_content', params: [] }]);
      return r[0]?.pending || {};
    } catch {
      return {};
    }
  }

  public async getTransactionByHash(hash: string): Promise<UniversalTransaction | null> {
    try {
      const r = await this.rateLimiter.execute(
        [{ method: 'eth_getTransactionByHash', params: [hash] }],
        this.batchCall
      );
      return r[0] ? this.normalizeRawTransaction(r[0]) : null;
    } catch {
      return null;
    }
  }

  // ===== NORMALIZATION =====

  private normalizeGethTrace(raw: any, blockNumber?: number, txHash?: string): UniversalTrace {
    return {
      transactionHash: txHash || raw.txHash || '',
      transactionPosition: raw.index ?? 0,
      type: (raw.type || 'call').toLowerCase(),
      action: { from: raw.from, to: raw.to, value: raw.value, gas: raw.gas, input: raw.input },
      result: raw.output !== undefined ? { output: raw.output, gasUsed: raw.gasUsed } : undefined,
      error: raw.error,
      subtraces: raw.calls?.length || 0,
      traceAddress: [],
    };
  }

  private normalizeParityTrace(raw: any): UniversalTrace {
    return {
      transactionHash: raw.transactionHash || '',
      transactionPosition: raw.transactionPosition || 0,
      type: raw.type || 'call',
      action: raw.action || {},
      result: raw.result,
      error: raw.error,
      subtraces: raw.subtraces || 0,
      traceAddress: raw.traceAddress || [],
    };
  }

  private normalizeBlockStats(raw: any): UniversalBlockStats {
    const gasLimit = quantityToNumber(raw.gasLimit);
    const gasUsed = quantityToNumber(raw.gasUsed);
    return {
      hash: normalizeHex(raw.hash),
      number: quantityToNumber(raw.number ?? raw.blockNumber),
      ...(raw.size !== undefined && { size: quantityToNumber(raw.size) }),
      gasLimit,
      gasUsed,
      gasUsedPercentage: gasLimit > 0 ? Math.round((gasUsed / gasLimit) * 100 * 100) / 100 : 0,
      timestamp: quantityToNumber(raw.timestamp),
      transactionCount: raw.transactions?.length || 0,
      baseFeePerGas: raw.baseFeePerGas ? quantityToDecimalString(raw.baseFeePerGas) : undefined,
      blobGasUsed: raw.blobGasUsed ? quantityToDecimalString(raw.blobGasUsed) : undefined,
      excessBlobGas: raw.excessBlobGas ? quantityToDecimalString(raw.excessBlobGas) : undefined,
      miner: normalizeAddress(raw.miner ?? raw.author ?? raw.feeRecipient),
      ...(raw.difficulty !== undefined && { difficulty: quantityToDecimalString(raw.difficulty) }),
      parentHash: normalizeHex(raw.parentHash),
      unclesCount: raw.uncles?.length || 0,
    };
  }

  private normalizeRawBlock(raw: any): UniversalBlock {
    const block: UniversalBlock = {
      hash: normalizeHex(raw.hash),
      parentHash: normalizeHex(raw.parentHash),
      ...(raw.nonce !== undefined && { nonce: normalizeHex(raw.nonce) }),
      ...(raw.sha3Uncles !== undefined && { sha3Uncles: normalizeHex(raw.sha3Uncles) }),
      ...(raw.logsBloom !== undefined && { logsBloom: normalizeHex(raw.logsBloom) }),
      transactionsRoot: normalizeHex(raw.transactionsRoot),
      stateRoot: normalizeHex(raw.stateRoot),
      ...(raw.receiptsRoot !== undefined && { receiptsRoot: normalizeHex(raw.receiptsRoot) }),
      miner: normalizeAddress(raw.miner ?? raw.author ?? raw.feeRecipient),
      ...(raw.difficulty !== undefined && { difficulty: quantityToDecimalString(raw.difficulty) }),
      ...(raw.totalDifficulty !== undefined && { totalDifficulty: quantityToDecimalString(raw.totalDifficulty) }),
      extraData: normalizeHex(raw.extraData),
      ...(raw.size !== undefined && { size: quantityToNumber(raw.size) }),
      gasLimit: quantityToNumber(raw.gasLimit),
      gasUsed: quantityToNumber(raw.gasUsed),
      timestamp: quantityToNumber(raw.timestamp),
      uncles: raw.uncles || [],
      baseFeePerGas: raw.baseFeePerGas ? quantityToDecimalString(raw.baseFeePerGas) : undefined,
      withdrawals: raw.withdrawals,
      withdrawalsRoot: raw.withdrawalsRoot,
      blobGasUsed: raw.blobGasUsed ? quantityToDecimalString(raw.blobGasUsed) : undefined,
      excessBlobGas: raw.excessBlobGas ? quantityToDecimalString(raw.excessBlobGas) : undefined,
      parentBeaconBlockRoot: raw.parentBeaconBlockRoot,
      transactions: raw.transactions?.map((tx: any) =>
        typeof tx === 'string' ? normalizeHex(tx) : this.normalizeRawTransaction(tx)
      ),
    };
    if (raw.blockNumber != null) block.blockNumber = quantityToNumber(raw.blockNumber);
    else if (raw.number != null) block.blockNumber = quantityToNumber(raw.number);
    return block;
  }

  private normalizeRawTransaction(raw: any): UniversalTransaction {
    return {
      hash: normalizeHex(raw.hash),
      nonce: quantityToNumber(raw.nonce),
      from: normalizeAddress(raw.from),
      to: raw.to ? normalizeAddress(raw.to) : null,
      value: quantityToDecimalString(raw.value),
      gas: quantityToNumber(raw.gas),
      input: normalizeHex(raw.input || raw.data || '0x'),
      blockHash: raw.blockHash ? normalizeHex(raw.blockHash) : null,
      blockNumber: optionalQuantityToNumber(raw.blockNumber),
      transactionIndex: optionalQuantityToNumber(raw.transactionIndex),
      gasPrice: raw.gasPrice ? quantityToDecimalString(raw.gasPrice) : undefined,
      chainId: raw.chainId ? quantityToNumber(raw.chainId) : undefined,
      v: raw.v ? normalizeHex(raw.v) : undefined,
      r: raw.r ? normalizeHex(raw.r) : undefined,
      s: raw.s ? normalizeHex(raw.s) : undefined,
      type: raw.type ? normalizeHex(raw.type) : '0x0',
      maxFeePerGas: raw.maxFeePerGas ? quantityToDecimalString(raw.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: raw.maxPriorityFeePerGas ? quantityToDecimalString(raw.maxPriorityFeePerGas) : undefined,
      accessList: raw.accessList,
      maxFeePerBlobGas: raw.maxFeePerBlobGas ? quantityToDecimalString(raw.maxFeePerBlobGas) : undefined,
      blobVersionedHashes: raw.blobVersionedHashes,
    };
  }

  private normalizeRawReceipt(raw: any): UniversalTransactionReceipt {
    return {
      transactionHash: normalizeHex(raw.transactionHash),
      transactionIndex: quantityToNumber(raw.transactionIndex),
      blockHash: normalizeHex(raw.blockHash),
      blockNumber: quantityToNumber(raw.blockNumber),
      from: normalizeAddress(raw.from),
      to: raw.to ? normalizeAddress(raw.to) : null,
      cumulativeGasUsed: quantityToNumber(raw.cumulativeGasUsed),
      gasUsed: quantityToNumber(raw.gasUsed),
      contractAddress: raw.contractAddress ? normalizeAddress(raw.contractAddress) : null,
      logs: (raw.logs || []).map((log: any) => ({
        address: normalizeAddress(log.address),
        topics: log.topics || [],
        data: normalizeHex(log.data || '0x'),
        blockNumber: optionalQuantityToNumber(log.blockNumber),
        transactionHash: log.transactionHash ? normalizeHex(log.transactionHash) : null,
        transactionIndex: optionalQuantityToNumber(log.transactionIndex),
        blockHash: log.blockHash ? normalizeHex(log.blockHash) : null,
        logIndex: optionalQuantityToNumber(log.logIndex),
        removed: log.removed || false,
      })),
      ...(raw.logsBloom !== undefined && { logsBloom: normalizeHex(raw.logsBloom) }),
      ...(raw.status !== undefined && {
        status: raw.status === '0x1' || raw.status === 1 || raw.status === true ? ('0x1' as const) : ('0x0' as const),
      }),
      ...(raw.root !== undefined && { root: normalizeHex(raw.root) }),
      type: raw.type ? normalizeHex(raw.type) : '0x0',
      ...(raw.effectiveGasPrice !== undefined && { effectiveGasPrice: quantityToDecimalString(raw.effectiveGasPrice) }),
      blobGasUsed: raw.blobGasUsed ? quantityToDecimalString(raw.blobGasUsed) : undefined,
      blobGasPrice: raw.blobGasPrice ? quantityToDecimalString(raw.blobGasPrice) : undefined,
    };
  }
}
