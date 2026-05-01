import type {
  EvmMempoolLoadInfo,
  EvmMempoolMemoryUsage,
  EvmMempoolProviderSnapshot,
  EvmMempoolReplacementCandidate,
  EvmMempoolStateSnapshotV2,
  EvmMempoolStateStore,
} from '../../../native';
import { getEvmNativeBindings } from '../../../native';
import type { MempoolTxMetadata } from '../../../blockchain-provider/providers/interfaces';

function canonicalHash(hash: string): string {
  return hash.startsWith('0x') || hash.startsWith('0X')
    ? `0x${hash.slice(2).toLowerCase()}`
    : `0x${hash.toLowerCase()}`;
}

function nonceKey(from: string, nonce: number): string {
  return `${from.toLowerCase()}:${nonce}`;
}

function effectiveGasPrice(meta: MempoolTxMetadata | undefined): bigint {
  if (!meta) return 0n;
  const parse = (value?: string): bigint => {
    if (!value) return 0n;
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  };
  return parse(meta.maxFeePerGas) || parse(meta.gasPrice);
}

function convertUnits(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB'): { unit: 'B' | 'KB' | 'MB' | 'GB'; div: number } {
  if (units === 'B') return { unit: 'B', div: 1 };
  if (units === 'KB') return { unit: 'KB', div: 1024 };
  if (units === 'GB') return { unit: 'GB', div: 1024 * 1024 * 1024 };
  return { unit: 'MB', div: 1024 * 1024 };
}

export class JsEvmMempoolStateStore implements EvmMempoolStateStore {
  private hashToId = new Map<string, number>();
  private idToHash = new Map<number, string>();
  private providerTx = new Map<string, Set<number>>();
  private metadataStore = new Map<number, MempoolTxMetadata>();
  private loadTracker = new Map<number, EvmMempoolLoadInfo>();
  private nonceIndex = new Map<string, number>();
  private nextId = 0;

  applySnapshot(perProvider: EvmMempoolProviderSnapshot): void {
    const oldLoad = new Map<string, EvmMempoolLoadInfo>();
    for (const [id, info] of this.loadTracker) {
      const hash = this.idToHash.get(id);
      if (hash) oldLoad.set(hash, info);
    }

    this.clearWithoutShrink();

    const seen = new Set<string>();
    for (const [provider, items] of Object.entries(perProvider)) {
      if (!Array.isArray(items)) continue;
      for (const { hash, metadata } of items) {
        const normalizedHash = canonicalHash(hash);
        if (seen.has(normalizedHash)) continue;
        seen.add(normalizedHash);

        const id = this.ensureId(normalizedHash);
        this.metadataStore.set(id, metadata);
        this.addProviderTx(provider, id);
        this.indexNonce(metadata, id);

        const previousLoad = oldLoad.get(normalizedHash);
        if (previousLoad) this.loadTracker.set(id, previousLoad);
      }
    }
  }

  addTransactions(perProvider: EvmMempoolProviderSnapshot, maxPendingCount: number): void {
    for (const [provider, items] of Object.entries(perProvider)) {
      if (!Array.isArray(items)) continue;
      for (const { hash, metadata } of items) {
        const normalizedHash = canonicalHash(hash);
        if (this.hashToId.has(normalizedHash)) continue;

        if (maxPendingCount > 0 && this.hashToId.size >= maxPendingCount) {
          this.evictLowestGas();
        }

        const id = this.ensureId(normalizedHash);
        this.metadataStore.set(id, metadata);
        this.addProviderTx(provider, id);
        this.indexNonce(metadata, id);
      }
    }
  }

  providers(): string[] {
    return Array.from(this.providerTx.keys());
  }

  pendingHashes(providerName: string, limit: number): string[] {
    const ids = this.providerTx.get(providerName);
    if (!ids) return [];

    const out: string[] = [];
    for (const id of ids) {
      if (this.loadTracker.has(id) || !this.metadataStore.has(id)) continue;
      const hash = this.idToHash.get(id);
      if (hash) out.push(hash);
      if (limit > 0 && out.length >= limit) break;
    }
    return out;
  }

  recordLoaded(loadedTransactions: Array<{ hash: string; metadata: MempoolTxMetadata; providerName?: string }>): void {
    const timestamp = Date.now();
    for (const { hash, metadata, providerName } of loadedTransactions) {
      const id = this.hashToId.get(canonicalHash(hash));
      if (id === undefined || this.loadTracker.has(id)) continue;
      this.loadTracker.set(id, {
        timestamp,
        effectiveGasPrice: effectiveGasPrice(metadata).toString(),
        providerName,
      });
    }
  }

  removeHash(hash: string): boolean {
    const normalizedHash = canonicalHash(hash);
    const id = this.hashToId.get(normalizedHash);
    if (id === undefined) return false;

    const meta = this.metadataStore.get(id);
    if (meta?.from && meta.nonce !== undefined) {
      const key = nonceKey(meta.from, meta.nonce);
      if (this.nonceIndex.get(key) === id) this.nonceIndex.delete(key);
    }
    this.metadataStore.delete(id);
    this.loadTracker.delete(id);
    for (const set of this.providerTx.values()) set.delete(id);
    this.hashToId.delete(normalizedHash);
    this.idToHash.delete(id);
    return true;
  }

  removeHashes(hashes: string[]): number {
    let removed = 0;
    for (const hash of hashes) {
      if (this.removeHash(hash)) removed++;
    }
    return removed;
  }

  getReplacementCandidate(from: string, nonce: number): EvmMempoolReplacementCandidate | undefined {
    const id = this.nonceIndex.get(nonceKey(from, nonce));
    if (id === undefined) return undefined;
    const hash = this.idToHash.get(id);
    const metadata = this.metadataStore.get(id);
    return hash && metadata ? { hash, metadata } : undefined;
  }

  *hashes(): Iterable<string> {
    yield* this.idToHash.values();
  }

  *metadata(): Iterable<MempoolTxMetadata> {
    yield* this.metadataStore.values();
  }

  hasTransaction(hash: string): boolean {
    return this.hashToId.has(canonicalHash(hash));
  }

  isTransactionLoaded(hash: string): boolean {
    const id = this.hashToId.get(canonicalHash(hash));
    return id !== undefined ? this.loadTracker.has(id) : false;
  }

  getTransactionMetadata(hash: string): MempoolTxMetadata | undefined {
    const id = this.hashToId.get(canonicalHash(hash));
    return id !== undefined ? this.metadataStore.get(id) : undefined;
  }

  getStats(): { total: number; loaded: number; providers: number; nonceIndex: number } {
    return {
      total: this.hashToId.size,
      loaded: this.loadTracker.size,
      providers: this.providerTx.size,
      nonceIndex: this.nonceIndex.size,
    };
  }

  pruneTtl(ttlMs: number, nowMs = Date.now()): number {
    if (ttlMs <= 0) return 0;
    const cutoff = nowMs - ttlMs;
    const toRemove: string[] = [];
    for (const [id, entry] of this.loadTracker) {
      if (entry.timestamp < cutoff) {
        const hash = this.idToHash.get(id);
        if (hash) toRemove.push(hash);
      }
    }
    return this.removeHashes(toRemove);
  }

  getMemoryUsage(units: 'B' | 'KB' | 'MB' | 'GB' = 'MB'): EvmMempoolMemoryUsage {
    const { unit, div } = convertUnits(units);
    const hashIndex = this.hashToId.size * (32 + 16);
    const metadata = this.metadataStore.size * 256;
    const loadTracker = this.loadTracker.size * 64;
    const providerTx = Array.from(this.providerTx.values()).reduce((sum, set) => sum + set.size * 4, 0);
    const nonceIndex = this.nonceIndex.size * 56;
    const total = hashIndex + metadata + loadTracker + providerTx + nonceIndex;
    const scale = (value: number) => value / div;

    return {
      unit,
      counts: {
        hashes: this.hashToId.size,
        metadata: this.metadataStore.size,
        loaded: this.loadTracker.size,
        providers: this.providerTx.size,
        nonceIndex: this.nonceIndex.size,
      },
      bytes: {
        hashIndex: scale(hashIndex),
        metadata: scale(metadata),
        loadTracker: scale(loadTracker),
        providerTx: scale(providerTx),
        nonceIndex: scale(nonceIndex),
        total: scale(total),
      },
    };
  }

  exportSnapshot(): EvmMempoolStateSnapshotV2 {
    const hashes = Array.from(this.idToHash.values());
    const hashById = (id: number) => this.idToHash.get(id);

    return {
      version: 2,
      hashes,
      providerTx: Array.from(this.providerTx.entries()).map(([provider, ids]) => [
        provider,
        Array.from(ids)
          .map(hashById)
          .filter((hash): hash is string => Boolean(hash)),
      ]),
      metadata: Array.from(this.metadataStore.entries())
        .map(([id, metadata]) => {
          const hash = hashById(id);
          return hash ? ([hash, metadata] as [string, MempoolTxMetadata]) : undefined;
        })
        .filter((entry): entry is [string, MempoolTxMetadata] => Boolean(entry)),
      loadTracker: Array.from(this.loadTracker.entries())
        .map(([id, info]) => {
          const hash = hashById(id);
          return hash ? ([hash, info] as [string, EvmMempoolLoadInfo]) : undefined;
        })
        .filter((entry): entry is [string, EvmMempoolLoadInfo] => Boolean(entry)),
      nonceIndex: Array.from(this.nonceIndex.entries())
        .map(([key, id]) => {
          const hash = hashById(id);
          return hash ? ([key, hash] as [string, string]) : undefined;
        })
        .filter((entry): entry is [string, string] => Boolean(entry)),
    };
  }

  importSnapshot(state: any): void {
    this.dispose();
    const snapshot = normalizeSnapshot(state);

    for (const hash of snapshot.hashes) this.ensureId(canonicalHash(hash));

    for (const [hash, metadata] of snapshot.metadata) {
      const id = this.ensureId(canonicalHash(hash));
      this.metadataStore.set(id, metadata);
      this.indexNonce(metadata, id);
    }

    for (const [provider, hashes] of snapshot.providerTx) {
      for (const hash of hashes) {
        const id = this.ensureId(canonicalHash(hash));
        this.addProviderTx(provider, id);
      }
    }

    for (const [hash, info] of snapshot.loadTracker) {
      const id = this.ensureId(canonicalHash(hash));
      this.loadTracker.set(id, info);
    }

    for (const [key, hash] of snapshot.nonceIndex) {
      const id = this.hashToId.get(canonicalHash(hash));
      if (id !== undefined) this.nonceIndex.set(String(key).toLowerCase(), id);
    }
  }

  dispose(): void {
    this.clearWithoutShrink();
  }

  private clearWithoutShrink(): void {
    this.hashToId.clear();
    this.idToHash.clear();
    this.providerTx.clear();
    this.metadataStore.clear();
    this.loadTracker.clear();
    this.nonceIndex.clear();
    this.nextId = 0;
  }

  private ensureId(hash: string): number {
    const existing = this.hashToId.get(hash);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.hashToId.set(hash, id);
    this.idToHash.set(id, hash);
    return id;
  }

  private addProviderTx(provider: string, id: number): void {
    let set = this.providerTx.get(provider);
    if (!set) {
      set = new Set<number>();
      this.providerTx.set(provider, set);
    }
    set.add(id);
  }

  private indexNonce(metadata: MempoolTxMetadata, id: number): void {
    if (metadata.from && metadata.nonce !== undefined) {
      this.nonceIndex.set(nonceKey(metadata.from, metadata.nonce), id);
    }
  }

  private evictLowestGas(): void {
    let lowestId: number | undefined;
    let lowestGas: bigint | undefined;

    for (const [id, metadata] of this.metadataStore) {
      const gas = effectiveGasPrice(metadata);
      if (lowestGas === undefined || gas < lowestGas) {
        lowestGas = gas;
        lowestId = id;
      }
    }

    if (lowestId === undefined) return;
    const hash = this.idToHash.get(lowestId);
    if (hash) this.removeHash(hash);
  }
}

function normalizeSnapshot(state: any): EvmMempoolStateSnapshotV2 {
  if (state?.version === 2) {
    return {
      version: 2,
      hashes: Array.isArray(state.hashes) ? state.hashes : [],
      providerTx: Array.isArray(state.providerTx) ? state.providerTx : [],
      metadata: Array.isArray(state.metadata) ? state.metadata : [],
      loadTracker: Array.isArray(state.loadTracker) ? state.loadTracker : [],
      nonceIndex: Array.isArray(state.nonceIndex) ? state.nonceIndex : [],
    };
  }

  // Legacy phase-1 shape used Map snapshots directly.
  const mapToEntries = <T>(value: unknown): Array<[string, T]> => {
    if (value instanceof Map) return Array.from(value.entries()).map(([key, val]) => [String(key), val as T]);
    if (Array.isArray(value)) return value as Array<[string, T]>;
    return [];
  };

  const txEntries = mapToEntries<string>(state?.txIndex);
  const idToHash = new Map<number, string>();
  for (const [id, hash] of txEntries) idToHash.set(Number(id), canonicalHash(hash));

  const metadata: Array<[string, MempoolTxMetadata]> = [];
  for (const [id, meta] of mapToEntries<MempoolTxMetadata>(state?.metaStore)) {
    const hash = idToHash.get(Number(id));
    if (hash) metadata.push([hash, meta]);
  }

  const loadTracker: Array<[string, EvmMempoolLoadInfo]> = [];
  for (const [id, info] of mapToEntries<EvmMempoolLoadInfo>(state?.loadTracker)) {
    const hash = idToHash.get(Number(id));
    if (hash) loadTracker.push([hash, info]);
  }

  const providerTx: Array<[string, string[]]> = [];
  const rawProvider =
    state?.providerTx instanceof Map
      ? state.providerTx
      : new Map(Array.isArray(state?.providerTx) ? state.providerTx : []);
  for (const [provider, ids] of rawProvider.entries()) {
    const hashes: string[] = [];
    for (const id of ids instanceof Set ? ids : Array.isArray(ids) ? ids : []) {
      const hash = idToHash.get(Number(id));
      if (hash) hashes.push(hash);
    }
    providerTx.push([String(provider), hashes]);
  }

  return {
    version: 2,
    hashes: Array.from(idToHash.values()),
    providerTx,
    metadata,
    loadTracker,
    nonceIndex: [],
  };
}

export function createEvmMempoolStateStore(): EvmMempoolStateStore {
  const NativeEvmMempoolState = getEvmNativeBindings()?.NativeEvmMempoolState;
  if (NativeEvmMempoolState) {
    try {
      return new NativeEvmMempoolState();
    } catch {
      // fall through to JS store
    }
  }

  return new JsEvmMempoolStateStore();
}
