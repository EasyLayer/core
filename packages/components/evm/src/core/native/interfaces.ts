import type { MempoolTxMetadata } from '../blockchain-provider/providers/interfaces';

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

export interface NativeRawBlock {
  hash: string;
  height: number;
  size: number;
  bytes: Buffer;
}

export interface NativeBlocksQueue {
  isQueueFull(): boolean;
  isQueueOverloaded(additionalSize: number): boolean;
  isMaxHeightReached(): boolean;
  getMaxBlockHeight(): number;
  setMaxBlockHeight(height: number): void;
  getMaxQueueSize(): number;
  setMaxQueueSize(size: number): void;
  getCurrentSize(): number;
  getLength(): number;
  getLastHeight(): number;
  validateEnqueue(meta: NativeBlockEnqueueMeta): void;
  enqueueBytes(hash: string, height: number, size: number, bytes: Buffer): void;
  getBlockSize(): number;
  setBlockSize(size: number): void;
  getBatchUpToSize(maxSize: number): NativeRawBlock[];
  findBlocks(hashes: string[]): NativeRawBlock[];
  dequeue(hashOrHashes: string | string[]): number;
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
  dispose(): void;
}

export interface NativeBlocksQueueConstructor {
  new (options: BlocksQueueNativeOptions): NativeBlocksQueue;
}

export interface EvmMempoolLoadInfo {
  timestamp: number;
  effectiveGasPrice: string;
  providerName?: string;
}

export interface EvmMempoolStateSnapshotV2 {
  version: 2;
  hashes: string[];
  providerTx: Array<[string, string[]]>;
  metadata: Array<[string, MempoolTxMetadata]>;
  loadTracker: Array<[string, EvmMempoolLoadInfo]>;
  nonceIndex: Array<[string, string]>;
}

export interface EvmMempoolMemoryUsage {
  unit: 'B' | 'KB' | 'MB' | 'GB';
  counts: {
    hashes: number;
    metadata: number;
    loaded: number;
    providers: number;
    nonceIndex: number;
  };
  bytes: {
    hashIndex: number;
    metadata: number;
    loadTracker: number;
    providerTx: number;
    nonceIndex: number;
    total: number;
  };
}

export type EvmMempoolProviderSnapshot = Record<string, Array<{ hash: string; metadata: MempoolTxMetadata }>>;

export interface EvmMempoolReplacementCandidate {
  hash: string;
  metadata: MempoolTxMetadata;
}

export interface EvmMempoolStateStore {
  applySnapshot(perProvider: EvmMempoolProviderSnapshot): void;
  addTransactions(perProvider: EvmMempoolProviderSnapshot, maxPendingCount: number): void;
  providers(): string[];
  pendingHashes(providerName: string, limit: number): string[];
  recordLoaded(loadedTransactions: Array<{ hash: string; metadata: MempoolTxMetadata; providerName?: string }>): void;
  removeHash(hash: string): boolean;
  removeHashes(hashes: string[]): number;
  getReplacementCandidate(from: string, nonce: number): EvmMempoolReplacementCandidate | undefined;
  hashes(): Iterable<string>;
  metadata(): Iterable<MempoolTxMetadata>;
  hasTransaction(hash: string): boolean;
  isTransactionLoaded(hash: string): boolean;
  getTransactionMetadata(hash: string): MempoolTxMetadata | undefined;
  getStats(): { total: number; loaded: number; providers: number; nonceIndex: number };
  pruneTtl(ttlMs: number, nowMs?: number): number;
  getMemoryUsage(units?: 'B' | 'KB' | 'MB' | 'GB'): EvmMempoolMemoryUsage;
  exportSnapshot(): EvmMempoolStateSnapshotV2;
  importSnapshot(state: any): void;
  dispose(): void;
}

export interface NativeEvmMempoolState extends EvmMempoolStateStore {}

export interface NativeEvmMempoolStateConstructor {
  new (): NativeEvmMempoolState;
}

export interface NativeEvmBindings {
  NativeBlocksQueue?: NativeBlocksQueueConstructor;
  NativeEvmMempoolState?: NativeEvmMempoolStateConstructor;
}
