import type { MempoolTxMetadata } from '../../../blockchain-provider/providers/interfaces';

// ===== INTERNAL DATA STRUCTURES FOR MEMPOOL AGGREGATE =====

/**
 * Maps tx hash → internal numeric id (memory-efficient).
 * Also provides reverse lookup: id → hash.
 */
export class TxHashIndex {
  private hashToId: Map<string, number> = new Map();
  private idToHash: Map<number, string> = new Map();
  private nextId = 0;

  add(hash: string): number {
    if (this.hashToId.has(hash)) return this.hashToId.get(hash)!;
    const id = this.nextId++;
    this.hashToId.set(hash, id);
    this.idToHash.set(id, hash);
    return id;
  }

  getByHash(hash: string): number | undefined {
    return this.hashToId.get(hash);
  }
  getById(id: number): string | undefined {
    return this.idToHash.get(id);
  }
  has(hash: string): boolean {
    return this.hashToId.has(hash);
  }
  hasId(id: number): boolean {
    return this.idToHash.has(id);
  }
  remove(hash: string): void {
    const id = this.hashToId.get(hash);
    if (id !== undefined) {
      this.hashToId.delete(hash);
      this.idToHash.delete(id);
    }
  }
  size(): number {
    return this.hashToId.size;
  }
  clear(): void {
    this.hashToId.clear();
    this.idToHash.clear();
  }
  __getMap(): Map<number, string> {
    return this.idToHash;
  }
  __setMap(m: Map<number, string>): void {
    this.idToHash = m;
    this.hashToId = new Map([...m.entries()].map(([id, hash]) => [hash, id]));
    this.nextId = m.size > 0 ? Math.max(...m.keys()) + 1 : 0;
  }
}

/**
 * Maps internal id → MempoolTxMetadata.
 * Stores only metadata (no input/calldata).
 */
export class MetadataStore {
  private store: Map<number, MempoolTxMetadata> = new Map();
  get(id: number): MempoolTxMetadata | undefined {
    return this.store.get(id);
  }
  set(id: number, meta: MempoolTxMetadata): void {
    this.store.set(id, meta);
  }
  has(id: number): boolean {
    return this.store.has(id);
  }
  remove(id: number): void {
    this.store.delete(id);
  }
  size(): number {
    return this.store.size;
  }
  __getMap(): Map<number, MempoolTxMetadata> {
    return this.store;
  }
  __setMap(m: Map<number, MempoolTxMetadata>): void {
    this.store = m;
  }
}

/**
 * Tracks which ids have been loaded (metadata fetched).
 * Stores: id → { timestamp, gasPrice, providerName }
 */
export interface LoadEntry {
  timestamp: number;
  effectiveGasPrice: string; // stored as string to avoid BigInt JSON serialization issues
  providerName?: string;
}

export class LoadTracker {
  private store: Map<number, LoadEntry> = new Map();
  add(id: number, entry: LoadEntry): void {
    this.store.set(id, entry);
  }
  has(id: number): boolean {
    return this.store.has(id);
  }
  get(id: number): LoadEntry | undefined {
    return this.store.get(id);
  }
  remove(id: number): void {
    this.store.delete(id);
  }
  count(): number {
    return this.store.size;
  }
  __getMap(): Map<number, LoadEntry> {
    return this.store;
  }
  __setMap(m: Map<number, LoadEntry>): void {
    this.store = m;
  }
}

/**
 * Maps providerName → Set<internal id> for per-provider tracking.
 */
export class ProviderTxMap {
  private store: Map<string, Set<number>> = new Map();
  add(provider: string, id: number): void {
    if (!this.store.has(provider)) this.store.set(provider, new Set());
    this.store.get(provider)!.add(id);
  }
  get(provider: string): Set<number> | undefined {
    return this.store.get(provider);
  }
  providers(): string[] {
    return Array.from(this.store.keys());
  }
  remove(provider: string, id: number): void {
    this.store.get(provider)?.delete(id);
  }
  removeId(id: number): void {
    for (const set of this.store.values()) set.delete(id);
  }
  __getMap(): Map<string, Set<number>> {
    return this.store;
  }
  __setMap(m: Map<string, Set<number>>): void {
    this.store = m;
  }
}

/**
 * Nonce-based index for replacement detection.
 * Maps "${from}:${nonce}" → internal id.
 * EVM-specific — no equivalent in bitcoin.
 */
export class NonceIndex {
  private store: Map<string, number> = new Map();
  key(from: string, nonce: number): string {
    return `${from.toLowerCase()}:${nonce}`;
  }
  set(from: string, nonce: number, id: number): void {
    this.store.set(this.key(from, nonce), id);
  }
  get(from: string, nonce: number): number | undefined {
    return this.store.get(this.key(from, nonce));
  }
  remove(from: string, nonce: number): void {
    this.store.delete(this.key(from, nonce));
  }
  removeById(id: number): void {
    for (const [k, v] of this.store.entries()) {
      if (v === id) {
        this.store.delete(k);
        return;
      }
    }
  }
  __getMap(): Map<string, number> {
    return this.store;
  }
  __setMap(m: Map<string, number>): void {
    this.store = m;
  }
}

/**
 * Adaptive batch sizer: adjusts per-provider fetch batch size
 * based on timing ratio (same algorithm as bitcoin).
 */
export class BatchSizer {
  private sizes: Map<string, number> = new Map();
  private readonly defaultSize: number;
  private readonly minSize: number;
  private readonly maxSize: number;

  constructor(defaultSize = 100, minSize = 10, maxSize = 1000) {
    this.defaultSize = defaultSize;
    this.minSize = minSize;
    this.maxSize = maxSize;
  }

  get(provider: string): number {
    return this.sizes.get(provider) ?? this.defaultSize;
  }

  /** ratio > 1 → current was slower → shrink. ratio < 1 → faster → grow. */
  tune(provider: string, ratio: number): void {
    const cur = this.get(provider);
    let next: number;
    if (ratio > 1.2) next = Math.max(this.minSize, Math.round(cur * 0.75));
    else if (ratio < 0.8) next = Math.min(this.maxSize, Math.round(cur * 1.25));
    else next = cur;
    this.sizes.set(provider, next);
  }

  clear(): void {
    this.sizes.clear();
  }
}
