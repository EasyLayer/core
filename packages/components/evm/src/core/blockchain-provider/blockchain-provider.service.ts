import { Injectable, Logger } from '@nestjs/common';
import type { NetworkConnectionManager, MempoolConnectionManager } from './managers';
import type { NetworkConfig, MempoolTxMetadata, Hash, MempoolStrategy } from './providers/interfaces';
import { BlockchainNormalizer } from './normalizer';
import type { Block, Trace } from './components/block.interfaces';
import type { TransactionReceipt } from './components/transaction.interfaces';
import { quantityToDecimalString, quantityToNumber, normalizeAddress, normalizeHex } from './value-normalization';

/**
 * A Subscription is a Promise that resolves once unsubscribed,
 * and also provides an `unsubscribe()` method.
 */
type Subscription = Promise<void> & { unsubscribe: () => void };

/**
 * BlockchainProviderService — main EVM blockchain operations interface.
 *
 * Architecture:
 * - NetworkConnectionManager: block/tx fetching with auto-failover
 * - MempoolConnectionManager: pending tx stream (optional, WS-based)
 * - Unified API for ethersjs/web3js providers
 */
@Injectable()
export class BlockchainProviderService {
  private readonly log = new Logger(BlockchainProviderService.name);
  private readonly normalizer: BlockchainNormalizer;

  constructor(
    private readonly networkManager: NetworkConnectionManager,
    private readonly mempoolManager: MempoolConnectionManager,
    private readonly networkConfig: NetworkConfig
  ) {
    this.normalizer = new BlockchainNormalizer(networkConfig);
  }

  get config(): NetworkConfig {
    return this.networkConfig;
  }
  get connectionManager(): NetworkConnectionManager {
    return this.networkManager;
  }

  /** @returns true if mempool providers are configured and connected */
  get isMempoolAvailable(): boolean {
    return this.mempoolManager.isAvailable;
  }

  // ===== INTERNAL =====

  private async execNetwork<T>(methodName: string, op: (provider: any) => Promise<T>): Promise<T> {
    try {
      const provider = await this.networkManager.getActiveProvider();
      return await op(provider);
    } catch (error) {
      try {
        const curr = await this.networkManager.getActiveProvider();
        const recovered = await this.networkManager.handleProviderFailure(curr.uniqName, error, methodName);
        return await op(recovered);
      } catch (recoveryError) {
        this.log.warn('Provider recovery failed', { args: { methodName, recoveryError } });
        throw recoveryError;
      }
    }
  }

  // ===== BLOCK HEIGHT =====

  /** Get current block height from network */
  public async getCurrentBlockHeight(): Promise<number> {
    return this.execNetwork('getCurrentBlockHeight', (p) => p.getBlockHeight());
  }

  /** Alias used by crawler for consistency with bitcoin package */
  public async getCurrentBlockHeightFromMempool(): Promise<number> {
    return this.getCurrentBlockHeight();
  }

  public async getCurrentBlockHeightFromNetwork(): Promise<number> {
    return this.getCurrentBlockHeight();
  }

  // ===== BLOCK METHODS =====

  public async getOneBlockByHeight(
    height: string | number,
    fullTransactions = false,
    verifyTrie = false
  ): Promise<Block | null> {
    return this.execNetwork('getOneBlockByHeight', async (provider) => {
      const h = Number(height);
      const rawBlocks = await provider.getManyBlocksByHeights([h], fullTransactions, verifyTrie);
      if (!rawBlocks?.length || !rawBlocks[0]) return null;
      const raw = rawBlocks[0];
      if (raw.blockNumber == null) raw.blockNumber = h;
      return this.normalizer.normalizeBlock(raw);
    });
  }

  public async getManyBlocksByHeights(
    heights: string[] | number[],
    fullTransactions = false,
    verifyTrie = false
  ): Promise<Block[]> {
    return this.execNetwork('getManyBlocksByHeights', async (provider) => {
      const numeric = heights.map(Number);
      const rawBlocks = await provider.getManyBlocksByHeights(numeric, fullTransactions, verifyTrie);
      return rawBlocks
        .filter((b: any): b is NonNullable<typeof b> => b !== null)
        .map((raw: any) => this.normalizer.normalizeBlock(raw));
    });
  }

  public async getOneBlockByHash(hash: string | Hash, fullTransactions = false): Promise<Block | null> {
    return this.execNetwork('getOneBlockByHash', async (provider) => {
      const rawBlocks = await provider.getManyBlocksByHashes([hash as Hash], fullTransactions);
      if (!rawBlocks?.length || !rawBlocks[0]) return null;
      const raw = rawBlocks[0];
      if (raw.blockNumber == null) {
        raw.blockNumber = await provider.getBlockHeight();
      }
      return this.normalizer.normalizeBlock(raw);
    });
  }

  public async getManyBlocksByHashes(hashes: string[] | Hash[], fullTransactions = false): Promise<Block[]> {
    return this.execNetwork('getManyBlocksByHashes', async (provider) => {
      const rawBlocks = await provider.getManyBlocksByHashes(hashes as Hash[], fullTransactions);
      const needHeight = rawBlocks.some((b: any) => b && b.blockNumber == null);
      const currentHeight = needHeight ? await provider.getBlockHeight() : 0;
      return rawBlocks
        .filter((b: any): b is NonNullable<typeof b> => b !== null)
        .map((raw: any) => {
          if (raw.blockNumber == null) raw.blockNumber = currentHeight;
          return this.normalizer.normalizeBlock(raw);
        });
    });
  }

  public async getOneBlockWithReceipts(
    height: string | number,
    fullTransactions = false,
    verifyTrie = false
  ): Promise<Block | null> {
    return this.execNetwork('getOneBlockWithReceipts', async (provider) => {
      const h = Number(height);
      const blocks = await provider.getManyBlocksWithReceipts([h], fullTransactions, verifyTrie);
      if (!blocks?.length || !blocks[0]) return null;
      const raw = blocks[0];
      if (raw.blockNumber == null) raw.blockNumber = h;
      return this.normalizer.normalizeBlock(raw);
    });
  }

  public async getManyBlocksWithReceipts(
    heights: string[] | number[],
    fullTransactions = false,
    verifyTrie = false
  ): Promise<Block[]> {
    return this.execNetwork('getManyBlocksWithReceipts', async (provider) => {
      const numeric = heights.map(Number);
      const rawBlocks = await provider.getManyBlocksWithReceipts(numeric, fullTransactions, verifyTrie);
      return rawBlocks
        .filter((b: any): b is NonNullable<typeof b> => b !== null)
        .map((raw: any) => this.normalizer.normalizeBlock(raw));
    });
  }

  public async getManyBlocksStatsByHeights(heights: string[] | number[]): Promise<any[]> {
    return this.execNetwork('getManyBlocksStatsByHeights', async (provider) => {
      const stats = await provider.getManyBlocksStatsByHeights(heights.map(Number));
      return stats.filter((s: any) => s !== null);
    });
  }

  public async mergeReceiptsIntoBlocks(blocks: Block[], receipts: TransactionReceipt[]): Promise<Block[]> {
    let receiptIndex = 0;
    for (const block of blocks) {
      const txCount = block.transactions?.length || 0;
      (block as any).receipts = txCount > 0 ? receipts.slice(receiptIndex, receiptIndex + txCount) : [];
      receiptIndex += txCount;
      // Re-normalize size fields using the normalizer (which uses BlockSizeCalculator internally)
      const renormalized = this.normalizer.normalizeBlock({ ...block } as any);
      block.size = renormalized.size;
      block.sizeWithoutReceipts = renormalized.sizeWithoutReceipts;
    }
    return blocks;
  }

  /**
   * Subscribes to new blocks via WebSocket.
   * Returns Subscription (Promise<void> & { unsubscribe() }).
   */
  public subscribeToNewBlocks(
    callback: (block: Block) => void,
    fullTransactions = true,
    verifyTrie = false
  ): Subscription {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    }) as Subscription;

    this.networkManager
      .getActiveProvider()
      .then((provider) => {
        if (!provider.hasWebSocketSupport || !provider.isWebSocketConnected) {
          reject(new Error('Provider does not support WebSocket'));
          return;
        }
        const sub = provider.subscribeToNewBlocks(async (blockNumber: number) => {
          try {
            const block = await this.getOneBlockWithReceipts(blockNumber, fullTransactions, verifyTrie);
            if (block) callback(block);
          } catch (e) {
            sub.unsubscribe();
            reject(e as Error);
          }
        });
        promise.unsubscribe = () => {
          sub.unsubscribe();
          resolve();
        };
      })
      .catch((e) => reject(e));

    return promise;
  }

  // ===== TRACE METHODS =====

  public async assertTraceSupport(): Promise<void> {
    if (!this.networkConfig.supportsTraces) {
      throw new Error(`Trace API is disabled by network config for chainId ${this.networkConfig.chainId}`);
    }
    await this.execNetwork('assertTraceSupport', (provider) => provider.assertTraceSupport());
  }

  /**
   * Loads traces for a block by height.
   * Tries debug_traceBlockByNumber (Geth) then trace_block (Erigon/OE).
   * Fails fast if traces are disabled or unsupported.
   * Should only be called when tracesEnabled=true in config.
   */
  public async getTracesByBlockHeight(height: number): Promise<Trace[]> {
    if (!this.networkConfig.supportsTraces) {
      throw new Error(`Trace API is disabled by network config for chainId ${this.networkConfig.chainId}`);
    }
    return this.execNetwork('getTracesByBlockHeight', async (provider) => {
      const universalTraces = await provider.getTracesByBlockNumber(height);
      return universalTraces.map((t: any) => ({
        transactionHash: t.transactionHash || '',
        transactionPosition: t.transactionPosition || 0,
        type: t.type || 'call',
        action: t.action || {},
        result: t.result,
        error: t.error,
        subtraces: t.subtraces || 0,
        traceAddress: t.traceAddress || [],
      }));
    });
  }

  /**
   * Loads traces for a single transaction.
   */
  public async getTracesByTransactionHash(hash: string): Promise<Trace[]> {
    if (!this.networkConfig.supportsTraces) {
      throw new Error(`Trace API is disabled by network config for chainId ${this.networkConfig.chainId}`);
    }
    return this.execNetwork('getTracesByTransactionHash', async (provider) => {
      const universalTraces = await provider.getTracesByTxHash(hash);
      return universalTraces.map((t: any) => ({
        transactionHash: t.transactionHash || hash,
        transactionPosition: t.transactionPosition || 0,
        type: t.type || 'call',
        action: t.action || {},
        result: t.result,
        error: t.error,
        subtraces: t.subtraces || 0,
        traceAddress: t.traceAddress || [],
      }));
    });
  }

  // ===== MEMPOOL METHODS =====

  /**
   * Subscribe to pending transaction hashes via WebSocket.
   * Uses MempoolConnectionManager provider.
   * Returns Subscription object.
   */
  public subscribeToPendingTransactions(callback: (txHash: string) => void): Subscription {
    const mempoolProvider = this.mempoolManager.getActiveProvider();
    if (!mempoolProvider) {
      const promise = Promise.resolve() as Subscription;
      promise.unsubscribe = () => {};
      this.log.warn('Mempool not available — subscribeToPendingTransactions is no-op');
      return promise;
    }

    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    }) as Subscription;
    const sub = mempoolProvider.subscribeToPendingTransactions(callback);
    promise.unsubscribe = () => {
      sub.unsubscribe();
      resolve();
    };
    return promise;
  }

  /**
   * Fetch pending tx metadata by hash.
   * Returns null if not found (already confirmed or dropped).
   */
  public async getPendingTransactionByHash(hash: string): Promise<MempoolTxMetadata | null> {
    const mempoolProvider = this.mempoolManager.getActiveProvider();
    if (!mempoolProvider) return null;
    try {
      const raw = await mempoolProvider.getTransactionByHash(hash);
      if (!raw) return null;
      return {
        hash: normalizeHex(raw.hash || hash),
        from: normalizeAddress(raw.from),
        to: raw.to ? normalizeAddress(raw.to) : null,
        nonce: quantityToNumber(raw.nonce),
        value: quantityToDecimalString(raw.value),
        gas: quantityToNumber(raw.gas),
        gasPrice: raw.gasPrice ? quantityToDecimalString(raw.gasPrice) : undefined,
        maxFeePerGas: raw.maxFeePerGas ? quantityToDecimalString(raw.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: raw.maxPriorityFeePerGas ? quantityToDecimalString(raw.maxPriorityFeePerGas) : undefined,
        type: raw.type ? normalizeHex(raw.type) : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch entire txpool_content (Geth/Erigon).
   * Returns per-provider raw mempool. May return empty if not supported.
   */
  public async getRawMempoolFromAll(): Promise<
    Array<{ providerName: string; value: Record<string, MempoolTxMetadata> }>
  > {
    const mempoolProvider = this.mempoolManager.getActiveProvider();
    if (!mempoolProvider) return [];
    try {
      const rawMempool = await mempoolProvider.getRawMempool();
      const normalized: Record<string, MempoolTxMetadata> = {};
      for (const [hash, raw] of Object.entries(rawMempool)) {
        if (!raw || typeof raw !== 'object') continue;
        normalized[normalizeHex((raw as any).hash || hash)] = {
          hash: normalizeHex((raw as any).hash || hash),
          from: normalizeAddress((raw as any).from),
          to: (raw as any).to ? normalizeAddress((raw as any).to) : null,
          nonce: quantityToNumber((raw as any).nonce),
          value: quantityToDecimalString((raw as any).value),
          gas: quantityToNumber((raw as any).gas),
          gasPrice: (raw as any).gasPrice ? quantityToDecimalString((raw as any).gasPrice) : undefined,
          maxFeePerGas: (raw as any).maxFeePerGas ? quantityToDecimalString((raw as any).maxFeePerGas) : undefined,
          maxPriorityFeePerGas: (raw as any).maxPriorityFeePerGas
            ? quantityToDecimalString((raw as any).maxPriorityFeePerGas)
            : undefined,
          type: (raw as any).type ? normalizeHex((raw as any).type) : undefined,
        };
      }
      return [{ providerName: mempoolProvider.uniqName, value: normalized }];
    } catch {
      return [];
    }
  }

  // ===== NETWORK INFO =====

  public isFeatureSupported(feature: 'eip1559' | 'withdrawals' | 'blobTransactions' | 'traces'): boolean {
    switch (feature) {
      case 'eip1559':
        return this.networkConfig.hasEIP1559;
      case 'withdrawals':
        return this.networkConfig.hasWithdrawals;
      case 'blobTransactions':
        return this.networkConfig.hasBlobTransactions;
      case 'traces':
        return this.networkConfig.supportsTraces;
      default:
        return false;
    }
  }

  public getNativeCurrencySymbol(): string {
    return this.networkConfig.nativeCurrencySymbol;
  }
  public getNativeCurrencyDecimals(): number {
    return this.networkConfig.nativeCurrencyDecimals;
  }
  public getChainId(): number {
    return this.networkConfig.chainId;
  }
}
