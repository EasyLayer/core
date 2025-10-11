import { BitcoinErrorHandler } from './errors';
import type { NetworkConfig } from './interfaces';

export interface BaseTransportOptions {
  uniqName: string;
  network: NetworkConfig;
}

/**
 * Abstract base transport defining a minimal, canonical surface for providers.
 *
 * Rules:
 * - No rate limiting lives here (transports handle it internally if needed).
 * - No public/protected batchCall here.
 * - Providers call only these abstract methods; transports implement or throw.
 * - Order of array results MUST match input; nulls MUST be preserved.
 */
export abstract class BaseTransport<T extends BaseTransportOptions = BaseTransportOptions> {
  public readonly uniqName: string;
  public readonly network: NetworkConfig;
  protected isConnected = false;

  constructor(options: T) {
    this.uniqName = options.uniqName;
    this.network = options.network;
  }

  /** Transport type must be explicitly 'rpc' | 'p2p' */
  abstract get type(): 'rpc' | 'p2p';
  abstract get connectionOptions(): T;

  // Connection management
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthcheck(): Promise<boolean>;

  // ===== Canonical API expected by providers =====

  // Blocks
  abstract requestHexBlocks(hashes: string[]): Promise<(Buffer | Uint8Array | null)[]>;
  abstract getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]>;
  abstract getBlockHeight(): Promise<number>;
  abstract getHeightsByHashes(hashes: string[]): Promise<(number | null)[]>;

  // Verbose blocks / headers / stats (RPC-only; P2P should throw)
  abstract getRawBlocksByHashesVerbose(hashes: string[], verbosity: 1 | 2): Promise<(any | null)[]>;
  abstract getBlockStatsByHashes(hashes: string[]): Promise<(any | null)[]>;
  abstract getBlockHeadersByHashes(hashes: string[]): Promise<(any | null)[]>;

  // Transactions
  abstract getRawTransactionsHexByTxids(txids: string[]): Promise<(string | null)[]>;
  abstract getRawTransactionsByTxids(txids: string[], verbosity: 1 | 2): Promise<(any | null)[]>;

  // Mempool / fees
  abstract getRawMempool(verbose?: boolean): Promise<any>;
  abstract getMempoolVerbose(): Promise<Record<string, any>>;
  abstract getMempoolEntries(txids: string[]): Promise<(any | null)[]>;
  abstract getMempoolInfo(): Promise<any>;
  abstract estimateSmartFee(confTarget: number, estimateMode?: 'ECONOMICAL' | 'CONSERVATIVE'): Promise<any>;

  // Chain info
  abstract getBlockchainInfo(): Promise<any>;
  abstract getNetworkInfo(): Promise<any>;

  // Streaming (optional): raw new blocks as bytes
  abstract subscribeToNewBlocks?(
    callback: (blockData: Buffer | Uint8Array) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void };

  /**
   * Handle transport errors with proper error classification
   */
  protected handleError(error: any, operation: string): never {
    const err = BitcoinErrorHandler.handleError(error, operation, {
      transport: this.type,
      provider: this.uniqName,
    });
    throw err;
  }

  /**
   * Execute operation with error handling
   */
  protected async executeWithErrorHandling<TResult>(
    operation: () => Promise<TResult>,
    operationName: string
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      this.handleError(error, operationName);
    }
  }

  /**
   * Throw error for unsupported operations
   */
  protected throwNotImplemented(method: string): never {
    throw new Error(`Method ${method} is not implemented for ${this.type} transport`);
  }

  get connected(): boolean {
    return this.isConnected;
  }
}
