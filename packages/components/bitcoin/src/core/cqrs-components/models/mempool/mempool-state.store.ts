import { requireBitcoinNativeMempoolState } from '../../../native';
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
const REQUIRED_NATIVE_MEMPOOL_METHODS: Array<keyof MempoolStateStore> = [
  'applySnapshot',
  'mergeSnapshot',
  'removeTxids',
  'providers',
  'pendingTxids',
  'recordLoaded',
  'txIds',
  'loadedTransactions',
  'metadata',
  'hasTransaction',
  'isTransactionLoaded',
  'getTransactionMetadata',
  'getFullTransaction',
  'getStats',
  'getMemoryUsage',
  'exportSnapshot',
  'importSnapshot',
  'dispose',
];

const NATIVE_MEMPOOL_METHOD_ALIASES: Partial<Record<keyof MempoolStateStore, string[]>> = {
  // napi-rs usually exposes js_name aliases, but some already-built artifacts may
  // expose Rust snake_case names for newly added methods. This is not a JS
  // fallback: both accepted names must be native functions on NativeMempoolState.
  mergeSnapshot: ['mergeSnapshot', 'merge_snapshot'],
  removeTxids: ['removeTxids', 'remove_txids'],
};

function availableNativeMethodNames(native: object): string[] {
  const names = new Set<string>();
  let cursor: any = native;

  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name !== 'constructor' && typeof (native as any)[name] === 'function') {
        names.add(name);
      }
    }
    cursor = Object.getPrototypeOf(cursor);
  }

  return [...names].sort();
}

function resolveNativeMethod<T extends keyof MempoolStateStore>(native: object, method: T): MempoolStateStore[T] {
  const aliases = NATIVE_MEMPOOL_METHOD_ALIASES[method] || [method as string];
  for (const alias of aliases) {
    const fn = (native as any)[alias];
    if (typeof fn === 'function') {
      return fn.bind(native);
    }
  }

  const available = availableNativeMethodNames(native);
  throw new Error(
    `NativeMempoolState binding is missing required method: ${String(method)}. ` +
      `Accepted native name(s): ${aliases.join(', ')}. ` +
      `Available native methods: ${available.length > 0 ? available.join(', ') : '<none>'}`
  );
}

function assertNativeMempoolStateContract(native: object): asserts native is MempoolStateStore {
  const missing = REQUIRED_NATIVE_MEMPOOL_METHODS.filter((method) => {
    const aliases = NATIVE_MEMPOOL_METHOD_ALIASES[method] || [method as string];
    return !aliases.some((alias) => typeof (native as any)[alias] === 'function');
  });

  if (missing.length > 0) {
    const available = availableNativeMethodNames(native);
    throw new Error(
      `NativeMempoolState binding is missing required method(s): ${missing.join(', ')}. ` +
        `Available native methods: ${available.length > 0 ? available.join(', ') : '<none>'}`
    );
  }
}

class NativeMempoolStateAdapter implements MempoolStateStore {
  private readonly nativeMergeSnapshot: MempoolStateStore['mergeSnapshot'];
  private readonly nativeRemoveTxids: MempoolStateStore['removeTxids'];

  constructor(private readonly native: MempoolStateStore) {
    assertNativeMempoolStateContract(native);
    this.nativeMergeSnapshot = resolveNativeMethod(native, 'mergeSnapshot');
    this.nativeRemoveTxids = resolveNativeMethod(native, 'removeTxids');
  }

  applySnapshot(perProvider: MempoolProviderSnapshot): void {
    this.native.applySnapshot(perProvider);
  }

  mergeSnapshot(perProvider: MempoolProviderSnapshot): void {
    // NativeMempoolState must implement the same contract as the JS store.
    // Do not silently applySnapshot() here: missing native merge support would
    // turn an additive refresh into a full replacement and hide a native API drift.
    this.nativeMergeSnapshot(perProvider);
  }

  removeTxids(txids: string[]): void {
    // Confirmed transaction cleanup is required state behavior. A missing native
    // removeTxids implementation is a contract error, not a safe no-op.
    this.nativeRemoveTxids(txids);
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
 * JavaScript mempool state store used only by direct unit tests and parity work.
 *
 * Production Node runtime uses the Rust native store. Missing or incomplete
 * native bindings are errors and must not silently switch to this class.
 *
 * Data layout mirrors the native design so behavior stays comparable:
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
 * Native Rust stores txids as 32 raw bytes. This JS test store stores txids as JS
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
   * FULL REPLACE — rebuilds the mempool snapshot indexes from scratch.
   * Preserves loaded data for txids still present in the new snapshot.
   * Only use for initial load or explicit reset.
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

  /**
   * ADDITIVE MERGE — adds new transactions and updates their metadata.
   * Does NOT remove transactions absent from the new snapshot.
   * Use this for periodic mempool refresh; use removeTxids() for confirmed tx cleanup.
   */
  mergeSnapshot(perProvider: MempoolProviderSnapshot): void {
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

        // Always update metadata (provider may have fresher fee data)
        this.metadataByHandle.set(handle, metadata);
        // Do NOT overwrite already-loaded transaction data
      }
    }
  }

  /**
   * Remove transactions by txid — called when transactions are confirmed in a block.
   * Cleans up metadata, loaded tx data, load tracker, and provider membership.
   */
  removeTxids(txids: string[]): void {
    for (const txid of txids) {
      const handle = this.txidToHandle.get(txid);
      if (handle === undefined) continue;

      this.metadataByHandle.delete(handle);
      this.txByHandle.delete(handle);
      this.loadByHandle.delete(handle);

      // Remove from all provider sets
      for (const set of this.providerTx.values()) {
        set.delete(handle);
      }

      // Remove from txid index
      // Note: we keep the handle slot to avoid reindexing; the txid slot becomes
      // a tombstone. This is safe because ensureHandle checks txidToHandle first.
      this.txidToHandle.delete(txid);
      // Mark the txids[] slot as empty string (tombstone)
      this.txids[handle] = '';
    }

    // Clean up empty provider sets
    for (const [provider, set] of this.providerTx.entries()) {
      if (set.size === 0) this.providerTx.delete(provider);
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
    for (const txid of this.txids) {
      if (txid) yield txid; // skip tombstones left by removeTxids()
    }
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
  const NativeMempoolState = requireBitcoinNativeMempoolState();

  try {
    return new NativeMempoolStateAdapter(new NativeMempoolState());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`NativeMempoolState binding was selected but failed to initialize: ${message}`);
  }
}
