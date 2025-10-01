export type ErrorParams = Record<string, any>;

export interface ErrorOptions<P extends ErrorParams = ErrorParams> {
  message?: string;
  params?: P;
}

/**
 * Base error class for all Bitcoin-related errors
 */
export class BaseError<P extends ErrorParams = ErrorParams> extends Error {
  public readonly params: P;

  constructor(message: string, params: P) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.params = params;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      params: this.params,
    };
  }
}

// Connection related errors
export class ConnectionError extends BaseError<ErrorParams> {
  constructor({ message = 'Failed to connect to Bitcoin node', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class TimeoutError extends BaseError<ErrorParams> {
  constructor({ message = 'Request timed out', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class RateLimitError extends BaseError<ErrorParams> {
  constructor({ message = 'Rate limit exceeded', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

// Not found errors
export class BlockNotFoundError extends BaseError<ErrorParams> {
  constructor({ message = 'Block not found', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class TransactionNotFoundError extends BaseError<ErrorParams> {
  constructor({ message = 'Transaction not found', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

// Validation errors
export class InvalidBlockHeightError extends BaseError<ErrorParams> {
  constructor({ message = 'Invalid block height', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class InvalidBlockHashError extends BaseError<ErrorParams> {
  constructor({ message = 'Invalid block hash', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class InvalidTransactionHashError extends BaseError<ErrorParams> {
  constructor({ message = 'Invalid transaction hash', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class ValidationError extends BaseError<ErrorParams> {
  constructor({ message = 'Validation failed', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

// RPC related errors
export class RpcError extends BaseError<ErrorParams> {
  constructor({ message = 'RPC call failed', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class BatchRequestError extends BaseError<ErrorParams> {
  constructor({ message = 'Batch request failed', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

// Processing errors
export class NormalizationError extends BaseError<ErrorParams> {
  constructor({ message = 'Failed to normalize data', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class ProviderError extends BaseError<ErrorParams> {
  constructor({ message = 'Provider error occurred', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

/**
 * Error handler utility class
 */
export class BitcoinErrorHandler {
  /**
   * Convert any error to appropriate Bitcoin error type
   */
  static handleError(error: any, operation: string, context: ErrorParams = {}): never {
    // If it's already our error type, just re-throw
    if (error instanceof BaseError) {
      throw error;
    }

    const errorMessage = error.message?.toLowerCase() || '';
    const params = { ...context, operation, originalError: error.message };

    // Rate limit - check first as it's most specific
    if (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('request limit reached') ||
      errorMessage.includes('/second request limit')
    ) {
      throw new RateLimitError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Timeout errors
    if (errorMessage.includes('timeout') || errorMessage.includes('etimedout') || errorMessage.includes('timed out')) {
      throw new TimeoutError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Connection errors
    if (
      errorMessage.includes('connection') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('econnreset') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('network') ||
      errorMessage.includes('host not found')
    ) {
      throw new ConnectionError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Not found errors
    if (
      errorMessage.includes('block not found') ||
      (errorMessage.includes('not found') && errorMessage.includes('block'))
    ) {
      throw new BlockNotFoundError({ message: `${operation} failed: ${error.message}`, params });
    }

    if (
      errorMessage.includes('transaction not found') ||
      (errorMessage.includes('not found') && errorMessage.includes('transaction'))
    ) {
      throw new TransactionNotFoundError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Validation errors
    if (errorMessage.includes('invalid block height') || errorMessage.includes('height out of range')) {
      throw new InvalidBlockHeightError({ message: `${operation} failed: ${error.message}`, params });
    }

    if (errorMessage.includes('invalid block hash') || errorMessage.includes('invalid hash')) {
      throw new InvalidBlockHashError({ message: `${operation} failed: ${error.message}`, params });
    }

    if (errorMessage.includes('invalid transaction hash') || errorMessage.includes('invalid txid')) {
      throw new InvalidTransactionHashError({ message: `${operation} failed: ${error.message}`, params });
    }

    // RPC errors
    if (errorMessage.includes('RPC error') || errorMessage.includes('jsonrpc')) {
      throw new RpcError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Default to provider error
    throw new ProviderError({ message: `${operation} failed: ${error.message}`, params });
  }
}
