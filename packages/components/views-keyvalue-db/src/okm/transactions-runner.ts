import { ConnectionManager } from './connection-manager';
import { AbstractBatch } from 'abstract-leveldown';

export class TransactionsRunner {
  private operations: AbstractBatch[] = [];
  private transactionActive = false;

  constructor(private readonly connectionManager: ConnectionManager) {}

  get connection() {
    return this.connectionManager.getConnection();
  }

  /**
   * Starts a transaction
   */
  startTransaction(): void {
    if (this.transactionActive) {
      throw new Error('Transaction is already active');
    }
    this.transactionActive = true;
    this.operations = [];
  }

  /**
   * Commits the transaction
   */
  async commitTransaction(): Promise<void> {
    if (!this.transactionActive) {
      throw new Error('No active transaction to commit');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.connection.batch(this.operations, (err: any) => {
          if (err) return reject(err);
          resolve();
        });
      });
      this.transactionActive = false;
      this.operations = [];
    } catch (err) {
      this.transactionActive = false;
      this.operations = [];
      throw err;
    }
  }

  /**
   * Rolls back the transaction
   */
  rollbackTransaction(): void {
    if (!this.transactionActive) {
      throw new Error('No active transaction to rollback');
    }
    this.transactionActive = false;
    this.operations = [];
  }

  /**
   * Adds an operation to the current transaction
   * @param operation The operation to add
   */
  addOperation(operation: AbstractBatch): void {
    if (!this.transactionActive) {
      throw new Error('No active transaction');
    }
    this.operations.push(operation);
  }

  /**
   * Adds an array of operations to the current transaction
   * @param operations The operations to add
   */
  addOperations(operations: AbstractBatch[]): void {
    operations.forEach((operation) => this.addOperation(operation));
  }

  /**
   * Checks if a transaction is active
   */
  isTransactionActive(): boolean {
    return this.transactionActive;
  }
}
