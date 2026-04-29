import { getBitcoinNativeBindings } from '../../../native';
import type {
  MempoolLoadInfo,
  MempoolMemoryUsage,
  MempoolProviderSnapshot,
  MempoolStateSnapshotV2,
  MempoolStateStore,
} from '../../../native';
import type { MempoolTxMetadata } from '../../../blockchain-provider';
import type { LightTransaction } from '../interfaces';

function createEmptySnapshot(): MempoolStateSnapshotV2 {
  return {
    version: 2,
    txids: [],
    providerTx: [],
    metadata: [],
    transactions: [],
    loadTracker: [],
  };
}

function normalizeMempoolSnapshotV2(state: any): MempoolStateSnapshotV2 {
  if (!state || (typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length === 0))
    return createEmptySnapshot();
  if (state.version === 2 || Array.isArray(state.txids) || Array.isArray(state.providerTx)) {
    return { ...createEmptySnapshot(), ...state };
  }

  throw new Error('Unsupported mempool snapshot format. Expected txid-based version 2 snapshot.');
}

/**
 * Thin adapter over the native Rust backing store.
 *
 * Important: this class is not a domain model. It only satisfies the
 * `MempoolStateStore` interface used privately by the TypeScript aggregate.
 * Refresh/sync decisions, provider RPC calls, domain events and CQRS lifecycle
 * stay in `Mempool`; this adapter only forwards state/index operations to Rust.
 */
class NativeMempoolStateAdapter implements MempoolStateStore {
  constructor(private readonly native: MempoolStateStore) {}

  applySnapshot(perProvider: MempoolProviderSnapshot): void {
    this.native.applySnapshot(perProvider);
  }

  providers(): string[] {
    return this.native.providers();
  }

  pendingTxids(providerName: string, limit: number): string[] {
    return this.native.pendingTxids(providerName, limit);
  }

  recordLoaded(
    loadedTransactions: Array<{
      txid: string;
      transaction: LightTransaction;
      providerName?: string;
    }>
  ): void {
    this.native.recordLoaded(loadedTransactions);
  }

  *txIds(): Iterable<string> {
    yield* this.native.txIds();
  }

  *loadedTransactions(): Iterable<LightTransaction> {
    yield* this.native.loadedTransactions();
  }

  *metadata(): Iterable<MempoolTxMetadata> {
    yield* this.native.metadata();
  }

  hasTransaction(txid: string): boolean {
    return this.native.hasTransaction(txid);
  }

  isTransactionLoaded(txid: string): boolean {
    return this.native.isTransactionLoaded(txid);
  }

  getTransactionMetadata(txid: string): MempoolTxMetadata | undefined {
    return this.native.getTransactionMetadata(txid);
  }

  getFullTransaction(txid: string): LightTransaction | undefined {
    return this.native.getFullTransaction(txid);
  }

  getStats(): { txids: number; metadata: number; transactions: number; providers: number } {
    return this.native.getStats();
  }

  getMemoryUsage(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB'): MempoolMemoryUsage {
    return this.native.getMemoryUsage(units);
  }

  exportSnapshot(): MempoolStateSnapshotV2 {
    return this.native.exportSnapshot();
  }

  importSnapshot(state: any): void {
    this.native.importSnapshot(normalizeMempoolSnapshotV2(state));
  }

  dispose(): void {
    this.native.dispose();
  }
}

/**
 * JavaScript fallback for the Rust mempool backing store.
 *
 * Data layout mirrors the native design so behavior stays identical when native
 * bindings are unavailable:
 * - `txidToHandle` maps a full txid string to a compact numeric handle;
 * - `txids[handle]` stores the canonical txid once;
 * - `providerTx` stores provider membership as handles instead of duplicated
 *   metadata objects;
 * - metadata, loaded transactions and load info are stored by handle.
 *
 * Algorithmic complexity:
 * - `ensureHandle` / `handleOf`: average O(1);
 * - `applySnapshot`: O(N + L), where N is the refreshed provider snapshot size
 *   and L is the old loaded/load-tracker size preserved by txid;
 * - `pendingTxids(provider, limit)`: O(K) for that provider's handle set, with
 *   early stop after `limit`;
 * - point lookups: average O(1);
 * - snapshot import/export: O(T + R), where T is txid count and R is stored
 *   provider/metadata/transaction/load records.
 *
 * Memory notes:
 * Native Rust stores txids as 32 raw bytes. This JS fallback stores txids as JS
 * strings and uses Map/Set objects, so its real V8 heap cost is higher than the
 * native store. The public `getMemoryUsage()` method intentionally returns the
 * same heuristic shape as native code, useful for relative comparisons but not
 * an exact `process.memoryUsage()` replacement.
 */
export class JsMempoolStateStore implements MempoolStateStore {
  private txidToHandle = new Map<string, number>();
  private txids: string[] = [];
  private providerTx = new Map<string, Set<number>>();
  private metadataByHandle = new Map<number, MempoolTxMetadata>();
  private txByHandle = new Map<number, LightTransaction>();
  private loadByHandle = new Map<number, MempoolLoadInfo>();

  private ensureHandle(txid: string): number {
    const existing = this.txidToHandle.get(txid);
    if (existing !== undefined) return existing;

    const handle = this.txids.length;
    this.txidToHandle.set(txid, handle);
    this.txids.push(txid);
    return handle;
  }

  private handleOf(txid: string): number | undefined {
    return this.txidToHandle.get(txid);
  }

  /**
   * Rebuilds the mempool snapshot indexes while preserving already loaded data
   * for txids that are still present after refresh.
   *
   * The `seen` set deduplicates txids globally across providers. This preserves
   * the previous model semantics where a transaction is represented once in the
   * mempool state even if multiple providers reported it.
   */
  applySnapshot(perProvider: MempoolProviderSnapshot): void {
    const oldTxByTxid = new Map<string, LightTransaction>();
    const oldLoadByTxid = new Map<string, MempoolLoadInfo>();

    for (const [handle, tx] of this.txByHandle) {
      const txid = this.txids[handle];
      if (txid) oldTxByTxid.set(txid, tx);
    }

    for (const [handle, info] of this.loadByHandle) {
      const txid = this.txids[handle];
      if (txid) oldLoadByTxid.set(txid, info);
    }

    this.txidToHandle = new Map();
    this.txids = [];
    this.providerTx = new Map();
    this.metadataByHandle = new Map();
    this.txByHandle = new Map();
    this.loadByHandle = new Map();

    const seen = new Set<string>();

    for (const [provider, items] of Object.entries(perProvider || {})) {
      const arr = Array.isArray(items) ? items : [];
      let set = this.providerTx.get(provider);

      for (const { txid, metadata } of arr) {
        if (!txid || seen.has(txid)) continue;

        seen.add(txid);
        const handle = this.ensureHandle(txid);
        if (!set) {
          set = new Set<number>();
          this.providerTx.set(provider, set);
        }
        set.add(handle);
        this.metadataByHandle.set(handle, metadata);

        const oldTx = oldTxByTxid.get(txid);
        if (oldTx) this.txByHandle.set(handle, oldTx);

        const oldLoad = oldLoadByTxid.get(txid);
        if (oldLoad) this.loadByHandle.set(handle, oldLoad);
      }
    }
  }

  providers(): string[] {
    return Array.from(this.providerTx.keys());
  }

  pendingTxids(providerName: string, limit: number): string[] {
    const set = this.providerTx.get(providerName);
    if (!set || limit <= 0) return [];

    const out: string[] = [];
    for (const handle of set) {
      if (out.length >= limit) break;
      if (this.loadByHandle.has(handle)) continue;
      if (!this.metadataByHandle.has(handle)) continue;
      const txid = this.txids[handle];
      if (txid) out.push(txid);
    }
    return out;
  }

  recordLoaded(
    loadedTransactions: Array<{
      txid: string;
      transaction: LightTransaction;
      providerName?: string;
    }>
  ): void {
    const now = Date.now();

    for (const { txid, transaction, providerName } of loadedTransactions || []) {
      if (!txid) continue;
      const handle = this.ensureHandle(txid);
      if (this.loadByHandle.has(handle)) continue;

      const feeRate =
        typeof transaction.feeRate === 'number' && Number.isFinite(transaction.feeRate) ? transaction.feeRate : 0;

      this.txByHandle.set(handle, transaction);
      this.loadByHandle.set(handle, { timestamp: now, feeRate, providerName });
    }
  }

  *txIds(): Iterable<string> {
    for (const txid of this.txids) yield txid;
  }

  *loadedTransactions(): Iterable<LightTransaction> {
    for (const [, tx] of this.txByHandle) yield tx;
  }

  *metadata(): Iterable<MempoolTxMetadata> {
    for (const [, md] of this.metadataByHandle) yield md;
  }

  hasTransaction(txid: string): boolean {
    return this.txidToHandle.has(txid);
  }

  isTransactionLoaded(txid: string): boolean {
    const handle = this.handleOf(txid);
    return handle !== undefined && this.loadByHandle.has(handle);
  }

  getTransactionMetadata(txid: string): MempoolTxMetadata | undefined {
    const handle = this.handleOf(txid);
    return handle === undefined ? undefined : this.metadataByHandle.get(handle);
  }

  getFullTransaction(txid: string): LightTransaction | undefined {
    const handle = this.handleOf(txid);
    return handle === undefined ? undefined : this.txByHandle.get(handle);
  }

  getStats(): { txids: number; metadata: number; transactions: number; providers: number } {
    return {
      txids: this.txids.length,
      metadata: this.metadataByHandle.size,
      transactions: this.txByHandle.size,
      providers: this.providerTx.size,
    };
  }

  getMemoryUsage(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB'): MempoolMemoryUsage {
    const txids = this.txids.length;
    const metadata = this.metadataByHandle.size;
    const transactions = this.txByHandle.size;
    const loaded = this.loadByHandle.size;
    const providers = this.providerTx.size;

    // Same public shape as the old implementation, but adjusted for handle-based storage.
    const txIndexBytes = txids * 40; // 32B txid bytes target + u32 handle/index overhead approximation
    const metadataBytes = metadata * 350;
    const txStoreBytes = transactions * 2000;
    const loadTrackerBytes = loaded * 48;
    const providerMapBytes = txids * 12; // provider set stores compact handles, not txid strings
    const totalBytes = txIndexBytes + metadataBytes + txStoreBytes + loadTrackerBytes + providerMapBytes;

    const factor = units === 'B' ? 1 : units === 'KB' ? 1024 : units === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;
    const conv = (b: number) => Math.round((b / factor) * 100) / 100;

    return {
      unit: units,
      counts: { txids, metadata, transactions, loaded, providers },
      bytes: {
        txIndex: conv(txIndexBytes),
        metadata: conv(metadataBytes),
        txStore: conv(txStoreBytes),
        loadTracker: conv(loadTrackerBytes),
        providerTx: conv(providerMapBytes),
        total: conv(totalBytes),
      },
    };
  }

  exportSnapshot(): MempoolStateSnapshotV2 {
    return {
      version: 2,
      txids: [...this.txids],
      providerTx: Array.from(this.providerTx.entries()).map(([provider, handles]) => [
        provider,
        Array.from(handles, (handle) => this.txids[handle]).filter((txid): txid is string => Boolean(txid)),
      ]),
      metadata: Array.from(this.metadataByHandle.entries()).flatMap(([handle, metadata]) => {
        const txid = this.txids[handle];
        return txid ? [[txid, metadata] as [string, MempoolTxMetadata]] : [];
      }),
      transactions: Array.from(this.txByHandle.entries()).flatMap(([handle, tx]) => {
        const txid = this.txids[handle];
        return txid ? [[txid, tx] as [string, LightTransaction]] : [];
      }),
      loadTracker: Array.from(this.loadByHandle.entries()).flatMap(([handle, info]) => {
        const txid = this.txids[handle];
        return txid ? [[txid, info] as [string, MempoolLoadInfo]] : [];
      }),
    };
  }

  importSnapshot(state: any): void {
    this.importSnapshotV2(normalizeMempoolSnapshotV2(state));
  }

  private resetStorage(): void {
    this.txidToHandle = new Map();
    this.txids = [];
    this.providerTx = new Map();
    this.metadataByHandle = new Map();
    this.txByHandle = new Map();
    this.loadByHandle = new Map();
  }

  dispose(): void {
    this.resetStorage();
  }

  private importSnapshotV2(state: Partial<MempoolStateSnapshotV2>): void {
    const snapshot = { ...createEmptySnapshot(), ...state };

    this.resetStorage();

    for (const txid of snapshot.txids || []) {
      if (txid) this.ensureHandle(txid);
    }

    for (const [provider, txids] of snapshot.providerTx || []) {
      const set = new Set<number>();
      for (const txid of txids || []) {
        if (!txid) continue;
        set.add(this.ensureHandle(txid));
      }
      if (set.size > 0) this.providerTx.set(provider, set);
    }

    for (const [txid, metadata] of snapshot.metadata || []) {
      if (!txid) continue;
      this.metadataByHandle.set(this.ensureHandle(txid), metadata);
    }

    for (const [txid, transaction] of snapshot.transactions || []) {
      if (!txid) continue;
      this.txByHandle.set(this.ensureHandle(txid), transaction);
    }

    for (const [txid, info] of snapshot.loadTracker || []) {
      if (!txid) continue;
      this.loadByHandle.set(this.ensureHandle(txid), info);
    }
  }
}

export function createMempoolStateStore(): MempoolStateStore {
  const NativeMempoolState = getBitcoinNativeBindings()?.NativeMempoolState;

  if (NativeMempoolState) {
    try {
      return new NativeMempoolStateAdapter(new NativeMempoolState());
    } catch {
      // Fallback keeps the package usable even when native bindings cannot initialize.
    }
  }

  return new JsMempoolStateStore();
}
