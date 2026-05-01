import type { Block } from '../blockchain-provider';
import type { MempoolTxMetadata } from '../blockchain-provider';
import type { LightTransaction } from '../cqrs-components/models/interfaces';

export interface BlocksQueueNativeOptions {
  lastHeight: number;
  maxQueueSize: number;
  blockSize: number;
  maxBlockHeight: number;
  plannerConfig?: {
    maxSlots?: number;
    minSlots?: number;
    minAvgBytes?: number;
    maxAvgBytes?: number;
    alpha?: number;
    growThreshold?: number;
    shrinkThreshold?: number;
    resizeCooldownMs?: number;
  };
}

export interface NativeBlockEnqueueMeta {
  hash: string;
  height: number;
  size: number;
}

export interface NativeBlocksQueue<T extends Block = Block> {
  isQueueFull(): boolean;
  isQueueOverloaded(additionalSize: number): boolean;
  getBlockSize(): number;
  setBlockSize(size: number): void;
  isMaxHeightReached(): boolean;
  getMaxBlockHeight(): number;
  setMaxBlockHeight(height: number): void;
  getMaxQueueSize(): number;
  setMaxQueueSize(size: number): void;
  getCurrentSize(): number;
  getLength(): number;
  getLastHeight(): number;
  firstBlock(): T | undefined;
  validateEnqueue(meta: NativeBlockEnqueueMeta): void;
  enqueueCleaned(block: T): void;
  /**
   * Compatibility/native safety alias. The TypeScript BlocksQueue path uses
   * validateEnqueue -> cleanupBlockHexData -> enqueueCleaned so hex is not copied
   * across the JS -> Rust boundary.
   */
  enqueue(block: T): void;
  dequeue(hashOrHashes: string | string[]): number;
  fetchBlockFromInStack(height: number): T | undefined;
  fetchBlockFromOutStack(height: number): T | undefined;
  findBlocks(hashes: string[]): T[];
  getBatchUpToSize(maxSize: number): T[];
  clear(): void;
  reorganize(height: number): void;
  getMemoryStats(): {
    bufferAllocated: number;
    blocksUsed: number;
    bufferEfficiency: number;
    avgBlockSize: number;
    indexesSize: number;
    memoryUsedBytes: number;
  };
  /**
   * Explicit lifecycle cleanup for native memory.
   * Does not unload the native addon; it only clears this queue instance.
   */
  dispose(): void;
}

export interface NativeBlocksQueueConstructor {
  new <T extends Block = Block>(options: BlocksQueueNativeOptions): NativeBlocksQueue<T>;
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
  applySnapshot(perProvider: MempoolProviderSnapshot): void;
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
  NativeBlocksQueue?: NativeBlocksQueueConstructor;
  NativeMempoolState?: NativeMempoolStateConstructor;
}
