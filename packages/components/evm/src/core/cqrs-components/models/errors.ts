export class BlockchainValidationError extends Error {
  constructor(message = 'Blockchain validation failed') {
    super(message);
    this.name = 'BlockchainValidationError';
  }
}
