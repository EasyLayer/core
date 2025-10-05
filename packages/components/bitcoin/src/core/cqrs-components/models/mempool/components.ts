import type { MempoolTransaction, MempoolTxMetadata } from '../../../blockchain-provider';

/**
 * Internal data-structures live INSIDE the aggregate state.
 * We keep them small, single-responsibility, and serializable via base serializer (Maps/Sets).
 * Each structure exposes only simple methods (O(1) where possible) and keeps invariants tight.
 */

/** 32-bit txid hashing helper (saves ~60 bytes per txid vs 64-char string) */
export function hashTxid32(txid: string): number {
  let hash = 0;
  for (let i = 0; i < txid.length; i++) hash = ((hash << 5) - hash + txid.charCodeAt(i)) & 0xffffffff;
  return hash >>> 0;
}

/** === TxIndex ===============================================================
 * Responsibility: single source of truth for txidHash<->txid mapping.
 * Complexity: add/get/remove/has are O(1).
 * Memory: ~4B per key + string storage (64B) + Map overhead.
 */
export class TxIndex {
  private h2s: Map<number, string> = new Map();

  add(txid: string): number {
    const h = hashTxid32(txid);
    this.h2s.set(h, txid);
    return h;
  }
  hasHash(h: number): boolean {
    return this.h2s.has(h);
  }
  getByHash(h: number): string | undefined {
    return this.h2s.get(h);
  }
  removeByHash(h: number): void {
    this.h2s.delete(h);
  }
  values(): Iterable<string> {
    return this.h2s.values();
  }
  keys(): Iterable<number> {
    return this.h2s.keys();
  }
  size(): number {
    return this.h2s.size;
  }
  clear(): void {
    this.h2s.clear();
  }

  /** expose for snapshots */
  __getMap() {
    return this.h2s;
  }
  __setMap(m: Map<number, string>) {
    this.h2s = m;
  }
}

/** === ProviderMap ===========================================================
 * Responsibility: which providers saw a tx.
 * Structure: Map<txidHash, Set<providerIndex>> and providerNames: string[].
 * Complexity: O(1) add/get/remove.
 * Memory: ~8–20B/txid (depending on #providers).
 */
export class ProviderMap {
  private txToProviders: Map<number, Set<number>> = new Map();
  private providerNames: string[] = [];

  getOrCreateProviderIndex(name: string): number {
    const idx = this.providerNames.indexOf(name);
    if (idx >= 0) return idx;
    this.providerNames.push(name);
    return this.providerNames.length - 1;
  }

  add(txHash: number, providerIdx: number) {
    let set = this.txToProviders.get(txHash);
    if (!set) {
      set = new Set<number>();
      this.txToProviders.set(txHash, set);
    }
    set.add(providerIdx);
  }

  getProviders(txHash: number): Set<number> | undefined {
    return this.txToProviders.get(txHash);
  }

  remove(txHash: number) {
    this.txToProviders.delete(txHash);
  }

  clear() {
    this.txToProviders.clear();
    this.providerNames = [];
  }

  getProviderName(i: number): string | undefined {
    return this.providerNames[i];
  }

  getProviderNames(): string[] {
    return [...this.providerNames];
  }

  /** expose for snapshots */
  __getMap() {
    return this.txToProviders;
  }
  __setMap(m: Map<number, Set<number>>) {
    this.txToProviders = m;
  }
  __getNames() {
    return this.providerNames;
  }
  __setNames(a: string[]) {
    this.providerNames = a;
  }
}

/** === MetadataStore =========================================================
 * Responsibility: hold verbose mempool metadata (from getrawmempool(true)).
 * Complexity: O(1) set/get/remove/size.
 * Memory: ~200–500B per entry (depends on node).
 */
export class MetadataStore {
  private m: Map<number, MempoolTxMetadata> = new Map();

  set(txHash: number, meta: MempoolTxMetadata) {
    this.m.set(txHash, meta);
  }
  get(txHash: number): MempoolTxMetadata | undefined {
    return this.m.get(txHash);
  }
  remove(txHash: number) {
    this.m.delete(txHash);
  }
  has(txHash: number): boolean {
    return this.m.has(txHash);
  }
  size(): number {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  entries(): IterableIterator<[number, MempoolTxMetadata]> {
    return this.m.entries();
  }

  /** expose for snapshots */
  __getMap() {
    return this.m;
  }
  __setMap(m: Map<number, MempoolTxMetadata>) {
    this.m = m;
  }
}

/** === TxStore ===========================================================
 * Responsibility: hold memory-slimmed tx objects (MempoolTransaction), i.e., only fields needed by business logic.
 * We never store full Transaction; normalize immediately upon load.
 * Complexity: O(1) put/get/remove/count.
 * Memory: ~1–2 KB per tx (depends on LightVin/LightVout density).
 */
export class TxStore {
  private m: Map<number, MempoolTransaction> = new Map();

  put(txHash: number, slim: MempoolTransaction) {
    this.m.set(txHash, slim);
  }
  get(txHash: number): MempoolTransaction | undefined {
    return this.m.get(txHash);
  }
  remove(txHash: number) {
    this.m.delete(txHash);
  }
  count(): number {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }

  /** expose for snapshots */
  __getMap() {
    return this.m;
  }
  __setMap(m: Map<number, MempoolTransaction>) {
    this.m = m;
  }
}

// /** === FeeRateIndex ==========================================================
//  * Responsibility: indexing by rounded feeRate for fast queries & distributions.
//  * Implementation: Map<roundedFeeRate, Set<txHash>>.
//  * Complexity: add/remove O(1); distribution scan O(buckets).
//  * Memory: small (≈ a few hundred KB for huge mempools).
//  */
// export class FeeRateIndex {
//   private buckets: Map<number, Set<number>> = new Map();
//   constructor(private precision = 10) {} // round to 0.1 sat/vB by default

//   private round(fr: number): number {
//     return Math.floor(fr * this.precision) / this.precision;
//   }

//   add(txHash: number, feeRate: number) {
//     const r = this.round(feeRate);
//     let set = this.buckets.get(r);
//     if (!set) {
//       set = new Set<number>();
//       this.buckets.set(r, set);
//     }
//     set.add(txHash);
//   }

//   remove(txHash: number, feeRate: number) {
//     const r = this.round(feeRate);
//     const set = this.buckets.get(r);
//     if (!set) return;
//     set.delete(txHash);
//     if (set.size === 0) this.buckets.delete(r);
//   }

//   distribution(): Record<number, number> {
//     const out: Record<number, number> = {};
//     for (const [k, v] of this.buckets) out[k] = v.size;
//     return out;
//   }

//   clear() {
//     this.buckets.clear();
//   }

//   /** expose for snapshots */
//   __getMap() {
//     return this.buckets;
//   }
//   __setMap(m: Map<number, Set<number>>) {
//     this.buckets = m;
//   }
// }

/** === LoadTracker ===========================================================
 * Responsibility: track which tx were already normalized+stored (ready), with feeRate and providerIndex.
 * Complexity: O(1).
 * Memory: tiny (~24B/tx + Map overhead).
 */
type LoadInfo = { timestamp: number; feeRate: number; providerIndex: number };
export class LoadTracker {
  private loaded: Map<number, LoadInfo> = new Map();

  mark(txHash: number, info: LoadInfo) {
    this.loaded.set(txHash, info);
  }
  isLoaded(txHash: number): boolean {
    return this.loaded.has(txHash);
  }
  get(txHash: number): LoadInfo | undefined {
    return this.loaded.get(txHash);
  }
  count(): number {
    return this.loaded.size;
  }
  remove(txHash: number) {
    this.loaded.delete(txHash);
  }
  clear() {
    this.loaded.clear();
  }

  /** expose for snapshots */
  __getMap() {
    return this.loaded;
  }
  __setMap(m: Map<number, LoadInfo>) {
    this.loaded = m;
  }
}
