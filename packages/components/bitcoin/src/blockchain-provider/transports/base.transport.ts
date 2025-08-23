import { BitcoinErrorHandler } from './errors';
import type { RateLimits, NetworkConfig } from './interfaces';
import { RateLimiter } from './rate-limiter';

export interface BaseTransportOptions {
  uniqName: string;
  rateLimits: RateLimits;
  network: NetworkConfig;
}

/**
 * Abstract base transport class defining unified interface for RPC and P2P transports
 * All transports must implement these methods or throw error for unsupported operations
 *
 * Key Design Principles:
 * - All batch methods support null values for failed/missing requests
 * - Single value methods throw errors on null responses
 * - Order guarantees maintained across all implementations
 * - Rate limiting handled consistently via RateLimiter
 */
export abstract class BaseTransport<T extends BaseTransportOptions = BaseTransportOptions> {
  protected rateLimiter: RateLimiter;
  public readonly uniqName: string;
  public readonly network: NetworkConfig;
  protected isConnected = false;

  constructor(options: T) {
    this.uniqName = options.uniqName;
    this.network = options.network;
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  abstract get type(): string;
  abstract get connectionOptions(): T;

  // Connection management
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthcheck(): Promise<boolean>;

  // Core transport methods - ALL transports must implement or throw error
  abstract batchCall<TResult = any>(calls: Array<{ method: string; params: any[] }>): Promise<(TResult | null)[]>;

  // Block retrieval methods - must work with both RPC and P2P
  abstract requestHexBlocks(hashes: string[]): Promise<Buffer[]>;
  abstract getManyBlockHashesByHeights(heights: number[]): Promise<(string | null)[]>;
  abstract getBlockHeight(): Promise<number>;

  // Optional subscription support - implement or throw error
  abstract subscribeToNewBlocks?(
    callback: (blockData: Buffer) => void,
    onError?: (err: Error) => void
  ): { unsubscribe: () => void };

  /**
   * Handle transport errors with proper error classification
   */
  protected handleError(error: any, operation: string): never {
    BitcoinErrorHandler.handleError(error, operation, {
      transport: this.type,
      provider: this.uniqName,
    });
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
