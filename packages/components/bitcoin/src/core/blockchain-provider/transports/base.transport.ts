import { BitcoinErrorHandler } from './errors';
import type { NetworkConfig } from './interfaces';

// Unified byte data type
export type ByteData = Buffer | Uint8Array;

export interface BaseTransportOptions {
  uniqName: string;
  network: NetworkConfig;
}

/**
 * Abstract base transport with consistent error handling
 */
export abstract class BaseTransport<T extends BaseTransportOptions = BaseTransportOptions> {
  public readonly uniqName: string;
  public readonly network: NetworkConfig;
  protected isConnected = false;

  constructor(options: T) {
    this.uniqName = options.uniqName;
    this.network = options.network;
  }

  abstract get type(): 'rpc' | 'p2p' | 'mempool.space';
  abstract get connectionOptions(): T;

  // ===== Connection management =====
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthcheck(): Promise<boolean>;

  // ===== Blocks =====
  abstract requestHexBlocks(hashes: string[]): Promise<(ByteData | null)[]>;
  abstract getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]>;
  abstract getBlockHeight(): Promise<number>;
  abstract getHeightsByHashes(hashes: string[]): Promise<(number | null)[]>;

  // ===== Verbose operations (RPC-only) =====
  abstract getRawBlocksByHashesVerbose(hashes: string[], verbosity: 1 | 2): Promise<(any | null)[]>;
  abstract getBlockStatsByHashes(hashes: string[]): Promise<(any | null)[]>;
  abstract getBlockHeadersByHashes(hashes: string[]): Promise<(any | null)[]>;

  // ===== Transactions =====
  abstract getRawTransactionsHexByTxids(txids: string[]): Promise<(string | null)[]>;
  abstract getRawTransactionsByTxids(txids: string[], verbosity: 1 | 2): Promise<(any | null)[]>;

  // ===== Mempool =====
  abstract getRawMempool(verbose: true): Promise<Record<string, any>>;
  abstract getRawMempool(verbose?: false): Promise<string[]>;
  abstract getMempoolInfo(): Promise<any>;
  abstract getMempoolEntries(txids: string[]): Promise<(any | null)[]>;
  abstract getMempoolVerbose(): Promise<Record<string, any>>;
  abstract estimateSmartFee(confTarget: number, estimateMode?: 'ECONOMICAL' | 'CONSERVATIVE'): Promise<any>;

  // ===== Chain info =====
  abstract getBlockchainInfo(): Promise<any>;
  abstract getNetworkInfo(): Promise<any>;

  // ===== Streaming (optional) =====
  abstract subscribeToNewBlocks?(
    callback: (blockData: ByteData) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void };

  // ===== Error handling =====

  protected handleError(error: any, operation: string): never {
    const err = BitcoinErrorHandler.handleError(error, operation, {
      transport: this.type,
      provider: this.uniqName,
    });
    throw err;
  }

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
   * Throw not implemented error with proper error handling
   * Use this instead of direct throw for consistency
   */
  protected throwNotImplemented(method: string): never {
    const error = new Error(`Method ${method} is not implemented for ${this.type} transport`);
    this.handleError(error, method);
  }

  get connected(): boolean {
    return this.isConnected;
  }
}
