import type { MempoolTxMetadata } from '../blockchain-provider';
import type { LightTransaction } from '../cqrs-components/models/interfaces';

export interface NativeMerkleVerifier {
  bitcoinComputeMerkleRoot(txidsBE: string[]): string;
  bitcoinVerifyMerkleRoot(txidsBE: string[], expectedRootBE: string): boolean;
  bitcoinVerifyWitnessCommitment(block: any): boolean;
}

export interface MempoolLoadInfo {
  timestamp: number;
  feeRate: number;
  providerName?: string;
}

export interface MempoolStateSnapshotV2 {
  version: 2;
  txids: string[];
  providerTx: Array<[string, string[]]>;
  metadata: Array<[string, MempoolTxMetadata]>;
  transactions: Array<[string, LightTransaction]>;
  loadTracker: Array<[string, MempoolLoadInfo]>;
}

export interface MempoolMemoryUsage {
  unit: 'B' | 'KB' | 'MB' | 'GB';
  counts: {
    txids: number;
    metadata: number;
    transactions: number;
    loaded: number;
    providers: number;
  };
  bytes: {
    txIndex: number;
    metadata: number;
    txStore: number;
    loadTracker: number;
    providerTx: number;
    total: number;
  };
}

export type MempoolProviderSnapshot = Record<string, Array<{ txid: string; metadata: MempoolTxMetadata }>>;

export interface MempoolStateStore {
  /**
   * FULL REPLACE — replaces the entire mempool state from a provider snapshot.
   * Used only for the initial load or explicit reset.
   * For incremental refresh use mergeSnapshot().
   */
  applySnapshot(perProvider: MempoolProviderSnapshot): void;
  /**
   * ADDITIVE MERGE — adds new transactions and updates metadata for existing ones.
   * Does NOT remove transactions that are absent from the new snapshot.
   * Transactions are only removed via removeTxids() when confirmed in a block.
   */
  mergeSnapshot(perProvider: MempoolProviderSnapshot): void;
  /**
   * Remove transactions by txid (e.g. confirmed in a block).
   * Cleans up all associated metadata, loaded data and load tracker entries.
   */
  removeTxids(txids: string[]): void;
  providers(): string[];
  pendingTxids(providerName: string, limit: number): string[];
  recordLoaded(
    loadedTransactions: Array<{
      txid: string;
      transaction: LightTransaction;
      providerName?: string;
    }>
  ): void;
  txIds(): Iterable<string>;
  loadedTransactions(): Iterable<LightTransaction>;
  metadata(): Iterable<MempoolTxMetadata>;
  hasTransaction(txid: string): boolean;
  isTransactionLoaded(txid: string): boolean;
  getTransactionMetadata(txid: string): MempoolTxMetadata | undefined;
  getFullTransaction(txid: string): LightTransaction | undefined;
  getStats(): { txids: number; metadata: number; transactions: number; providers: number };
  getMemoryUsage(units?: 'B' | 'KB' | 'MB' | 'GB'): MempoolMemoryUsage;
  exportSnapshot(): MempoolStateSnapshotV2;
  importSnapshot(state: any): void;
  /**
   * Explicit lifecycle cleanup for store-owned memory.
   * Does not unload the native addon and does not emit domain events.
   */
  dispose(): void;
}

export interface NativeMempoolState extends MempoolStateStore {}

export interface NativeMempoolStateConstructor {
  new (): NativeMempoolState;
}

export interface NativeBitcoinBindings {
  NativeMempoolState?: NativeMempoolStateConstructor;
  NativeMerkleVerifier?: NativeMerkleVerifier;
}
