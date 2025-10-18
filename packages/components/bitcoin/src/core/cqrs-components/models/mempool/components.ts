import type { MempoolTxMetadata } from '../../../blockchain-provider';
import type { LightTransaction } from '../interfaces';

/**
 * Internal data-structures live INSIDE the aggregate state.
 * Keep them small, SRP, and snapshot-friendly (Maps/Sets only).
 */

/** 32-bit txid hashing helper (saves ~60 bytes per txid vs 64-char string) */
export function hashTxid32(txid: string): number {
  let hash = 0;
  for (let i = 0; i < txid.length; i++) hash = ((hash << 5) - hash + txid.charCodeAt(i)) & 0xffffffff;
  return hash >>> 0;
}

/** === TxIndex ===============================================================
 * (bi-directional) hash <-> txid mapping
 * Memory: O(n). All operations: O(1).
 */
export class TxIndex {
  private h2s = new Map<number, string>();
  private s2h = new Map<string, number>();

  add(txid: string): number {
    const existing = this.s2h.get(txid);
    if (existing != null) return existing;
    const h = hashTxid32(txid);
    this.h2s.set(h, txid);
    this.s2h.set(txid, h);
    return h;
  }
  getByHash(h: number): string | undefined {
    return this.h2s.get(h);
  }
  getByTxid(txid: string): number | undefined {
    return this.s2h.get(txid);
  }
  hasHash(h: number): boolean {
    return this.h2s.has(h);
  }
  hasTxid(txid: string): boolean {
    return this.s2h.has(txid);
  }
  removeByHash(h: number): void {
    const id = this.h2s.get(h);
    if (id != null) this.s2h.delete(id);
    this.h2s.delete(h);
  }
  clear(): void {
    this.h2s.clear();
    this.s2h.clear();
  }
  size(): number {
    return this.h2s.size;
  }
  /** expose for snapshots */
  __getMap() {
    return this.h2s;
  }
  __setMap(m: Map<number, string>) {
    this.h2s = m;
  }
}

/** === MetadataStore =========================================================
 * Store mempool metadata by tx hash.
 * Memory: O(n). Ops: O(1).
 */
export class MetadataStore {
  private byHash = new Map<number, MempoolTxMetadata>();

  set(h: number, m: MempoolTxMetadata) {
    this.byHash.set(h, m);
  }
  get(h: number) {
    return this.byHash.get(h);
  }
  has(h: number) {
    return this.byHash.has(h);
  }
  remove(h: number) {
    this.byHash.delete(h);
  }
  clear() {
    this.byHash.clear();
  }
  size() {
    return this.byHash.size;
  }
  entries() {
    return this.byHash.entries();
  }
  keys() {
    return this.byHash.keys();
  }
  /** expose for snapshots */
  __getMap() {
    return this.byHash;
  }
  __setMap(m: Map<number, MempoolTxMetadata>) {
    this.byHash = m;
  }
}

/** === TxStore ===============================================================
 * Store slim transactions (normalized) by tx hash.
 */
export class TxStore {
  private byHash = new Map<number, LightTransaction>();
  set(h: number, tx: LightTransaction) {
    this.byHash.set(h, tx);
  }
  get(h: number) {
    return this.byHash.get(h);
  }
  has(h: number) {
    return this.byHash.has(h);
  }
  remove(h: number) {
    this.byHash.delete(h);
  }
  clear() {
    this.byHash.clear();
  }
  size() {
    return this.byHash.size;
  }
  entries() {
    return this.byHash.entries();
  }
  /** expose for snapshots */
  __getMap() {
    return this.byHash;
  }
  __setMap(m: Map<number, LightTransaction>) {
    this.byHash = m;
  }
}

/** === ProviderTxMap =========================================================
 * For each providerName keep a Set of tx hashes assigned to it.
 * We intentionally assign a txid to at most ONE provider (dedup across providers).
 * Memory: O(p + n). Ops: O(1) average.
 */
export class ProviderTxMap {
  private map = new Map<string, Set<number>>();
  add(provider: string, h: number) {
    let s = this.map.get(provider);
    if (!s) this.map.set(provider, (s = new Set()));
    s.add(h);
  }
  get(provider: string): Set<number> | undefined {
    return this.map.get(provider);
  }
  providers(): string[] {
    return Array.from(this.map.keys());
  }
  clear() {
    this.map.clear();
  }
  /** expose for snapshots */
  __getMap() {
    return this.map;
  }
  __setMap(m: Map<string, Set<number>>) {
    this.map = m;
  }
}

/** === LoadTracker ===========================================================
 * Track which txids were loaded as slim transactions + feeRate snapshot at load time.
 * Used for sync progress and to preserve already loaded txs during refresh.
 */
export interface LoadInfo {
  timestamp: number;
  feeRate: number;
  providerName?: string;
}
export class LoadTracker {
  private loaded = new Map<number, LoadInfo>();
  add(txHash: number, info: LoadInfo) {
    this.loaded.set(txHash, info);
  }
  has(txHash: number) {
    return this.loaded.has(txHash);
  }
  get(txHash: number) {
    return this.loaded.get(txHash);
  }
  remove(txHash: number) {
    this.loaded.delete(txHash);
  }
  clear() {
    this.loaded.clear();
  }
  count() {
    return this.loaded.size;
  }
  /** expose for snapshots */
  __getMap() {
    return this.loaded;
  }
  __setMap(m: Map<number, LoadInfo>) {
    this.loaded = m;
  }
}

/** === BatchSizer (per‑provider adaptive logic) ==============================
 * Maintains per‑provider batch sizes and adapts using last duration ratio.
 * Complexity: O(1) updates.
 */
export class BatchSizer {
  private sizeByProvider = new Map<string, number>();
  private defaultSize: number;
  private minSize: number;
  private maxSize: number;

  constructor(defaultSize = 200, minSize = 20, maxSize = 2000) {
    this.defaultSize = defaultSize;
    this.minSize = minSize;
    this.maxSize = maxSize;
  }

  get(provider: string): number {
    const v = this.sizeByProvider.get(provider);
    if (!v || v <= 0) {
      this.sizeByProvider.set(provider, this.defaultSize);
      return this.defaultSize;
    }
    return v;
  }

  /** Update using ratio = currentDurationMs / previousDurationMs */
  tune(provider: string, ratio: number) {
    let v = this.get(provider);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    if (ratio > 1.25)
      v = Math.max(this.minSize, Math.round(v * 0.8)); // slower -> shrink
    else if (ratio < 0.8) v = Math.min(this.maxSize, Math.round(v * 1.2)); // faster -> grow
    this.sizeByProvider.set(provider, v);
  }

  clear() {
    this.sizeByProvider.clear();
  }
}
