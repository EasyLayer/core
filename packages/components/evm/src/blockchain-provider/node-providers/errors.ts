export type ErrorParams = Record<string, any>;

export interface ErrorOptions<P extends ErrorParams = ErrorParams> {
  message?: string;
  params?: P;
}

/**
 * Base error class for all EVM-related errors
 */
export class BaseError<P extends ErrorParams = ErrorParams> extends Error {
  public readonly params: P;

  constructor(message: string, params: P) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.params = params;
  }

  toJSON(includeStack: boolean = false) {
    const result: any = {
      name: this.name,
      message: this.message,
      params: this.params,
    };

    if (includeStack && this.stack) {
      result.stack = this.stack;
    }

    return result;
  }
}

// Connection related errors
export class ConnectionError extends BaseError<ErrorParams> {
  constructor({ message = 'Failed to connect to EVM node', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class WebsocketNotAvailableError extends BaseError<ErrorParams> {
  constructor({ message = 'WebSocket not available', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class WebsocketConnectionError extends BaseError<ErrorParams> {
  constructor({ message = 'WebSocket connection failed', params = {} }: ErrorOptions<ErrorParams> = {}) {
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

export class ReceiptNotFoundError extends BaseError<ErrorParams> {
  constructor({ message = 'Receipt not found', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

// Chain validation errors
export class ChainIdMismatchError extends BaseError<ErrorParams> {
  constructor({ message = 'Chain ID mismatch', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

// Request related errors
export class BatchRequestError extends BaseError<ErrorParams> {
  constructor({ message = 'Batch request failed', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}

export class SubscriptionError extends BaseError<ErrorParams> {
  constructor({ message = 'Subscription failed', params = {} }: ErrorOptions<ErrorParams> = {}) {
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
 * Error handler utility class for EVM networks
 */
export class BlockchainErrorHandler {
  /**
   * Convert any error to appropriate EVM error type
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
      errorMessage.includes('request limit reached')
    ) {
      throw new RateLimitError({ message: `${operation} failed: ${error.message}`, params });
    }

    // WebSocket errors
    if (errorMessage.includes('websocket') || errorMessage.includes('ws')) {
      throw new WebsocketConnectionError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Chain ID validation
    if (errorMessage.includes('chain id') || errorMessage.includes('chainid')) {
      throw new ChainIdMismatchError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Connection errors
    if (
      errorMessage.includes('connection') ||
      errorMessage.includes('network') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('econnreset') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('host not found')
    ) {
      throw new ConnectionError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Not found errors - be more specific
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

    if (
      errorMessage.includes('receipt not found') ||
      (errorMessage.includes('not found') && errorMessage.includes('receipt'))
    ) {
      throw new ReceiptNotFoundError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Generic not found
    if (errorMessage.includes('not found')) {
      throw new ProviderError({ message: `${operation} failed: ${error.message}`, params });
    }

    // Default to provider error
    throw new ProviderError({ message: `${operation} failed: ${error.message}`, params });
  }
}
