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

export interface MempoolNotLoadedErrorParams extends ErrorParams {
  loaded: boolean;
  nodeInfo?: any;
}

export class MempoolNotLoadedError extends BaseError<MempoolNotLoadedErrorParams> {
  constructor({
    message = 'Mempool is not loaded/enabled in Bitcoin Core node',
    params = {} as MempoolNotLoadedErrorParams,
  }: ErrorOptions<MempoolNotLoadedErrorParams> = {}) {
    super(message, params);
  }
}

export interface MempoolSizeMismatchErrorParams extends ErrorParams {
  expectedSize: number;
  actualSize: number;
  operation: string;
  mempoolInfo?: any;
}

export class MempoolSizeMismatchError extends BaseError<MempoolSizeMismatchErrorParams> {
  constructor({
    message = 'Mempool size mismatch - node returned incomplete transaction list',
    params = {} as MempoolSizeMismatchErrorParams,
  }: ErrorOptions<MempoolSizeMismatchErrorParams> = {}) {
    super(message, params);
  }
}
export interface ReorganizationGenesisErrorParams extends ErrorParams {
  startHeight: number;
  endHeight: number;
  searchDepth: number;
  aggregateId: string;
  requestId: string;
}

export class ReorganizationGenesisError extends BaseError<ReorganizationGenesisErrorParams> {
  constructor({
    message = 'Reorganization failed: reached genesis without finding fork point',
    params = {} as ReorganizationGenesisErrorParams,
  }: ErrorOptions<ReorganizationGenesisErrorParams> = {}) {
    super(message, params);
  }
}
