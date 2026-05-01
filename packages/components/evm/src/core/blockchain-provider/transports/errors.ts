export class TransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export class RpcError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'RpcError';
  }
}

export class ProviderError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ProviderError';
  }
}

export class TraceUnsupportedError extends ProviderError {
  constructor(message = 'EVM provider does not support trace APIs') {
    super(message);
    this.name = 'TraceUnsupportedError';
  }
}
