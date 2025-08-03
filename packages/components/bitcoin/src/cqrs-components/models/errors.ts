export type ErrorParams = Record<string, any>;

export interface ErrorOptions<P extends ErrorParams = ErrorParams> {
  message?: string;
  params?: P;
}

export class BaseError<P extends ErrorParams = ErrorParams> extends Error {
  public readonly params: P;

  constructor(message: string, params: P) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.params = params;
  }
}

export class BlockchainValidationError extends BaseError<ErrorParams> {
  constructor({ message = 'Reorganization is needed.', params = {} }: ErrorOptions<ErrorParams> = {}) {
    super(message, params);
  }
}
